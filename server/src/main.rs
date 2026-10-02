use anyhow::Result;
use bytes::Bytes;
use certon::{AcmeIssuer, FileStorage, Http01Solver, acme_issuer::CertIssuer};
use rcgen::{CertificateParams, KeyPair};
use salvo::conn::rustls::{Keycert, RustlsConfig};
use salvo::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration as StdDuration, Instant},
};
use time::{Duration, OffsetDateTime};
use tokio::io::AsyncWriteExt;
use tokio::sync::broadcast;

const MAX_PLAYERS: usize = 32;
const MAX_PACKET: usize = 512;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Position {
    x: f32,
    y: f32,
    z: f32,
    yaw: f32,
    bank: f32,
    speed: f32,
    flying: bool,
    spread: f32,
    flap: bool,
}

impl Position {
    fn valid(&self) -> bool {
        [
            self.x,
            self.y,
            self.z,
            self.yaw,
            self.bank,
            self.speed,
            self.spread,
        ]
        .iter()
        .all(|value| value.is_finite())
            && self.x.abs() <= 450.0
            && self.z.abs() <= 450.0
            && (-50.0..=300.0).contains(&self.y)
            && self.yaw.abs() <= 100_000.0
            && self.bank.abs() <= 1.0
            && (0.0..=100.0).contains(&self.speed)
            && (0.0..=1.0).contains(&self.spread)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Update {
    v: u8,
    sequence: u32,
    position: Position,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Event {
    Welcome {
        id: u64,
    },
    State {
        id: u64,
        sequence: u32,
        position: Position,
    },
    Leave {
        id: u64,
    },
}

#[derive(Clone)]
struct Player {
    sequence: u32,
    position: Position,
}

struct Room {
    next_id: AtomicU64,
    players: Mutex<HashMap<u64, Player>>,
    events: broadcast::Sender<Event>,
}

struct PlayerGuard {
    room: Arc<Room>,
    id: u64,
}

impl Drop for PlayerGuard {
    fn drop(&mut self) {
        self.room.players.lock().unwrap().remove(&self.id);
        let _ = self.room.events.send(Event::Leave { id: self.id });
    }
}

impl Room {
    fn new() -> Arc<Self> {
        let (events, _) = broadcast::channel(256);
        Arc::new(Self {
            next_id: AtomicU64::new(1),
            players: Mutex::new(HashMap::new()),
            events,
        })
    }
}

#[derive(Debug)]
struct CertificateHash([u8; 32]);

#[handler]
impl CertificateHash {
    async fn handle(&self) -> Json<[u8; 32]> {
        Json(self.0)
    }
}

fn local_certificate() -> Result<(RustlsConfig, CertificateHash)> {
    let mut params = CertificateParams::new(vec!["localhost".into(), "127.0.0.1".into()])?;
    let now = OffsetDateTime::now_utc();
    params.not_before = now - Duration::minutes(1);
    params.not_after = now + Duration::days(13);
    let key = KeyPair::generate()?;
    let certificate = params.self_signed(&key)?;
    let hash = Sha256::digest(certificate.der().as_ref()).into();
    let config = RustlsConfig::new(
        Keycert::new()
            .cert(certificate.pem().into_bytes())
            .key(key.serialize_pem().into_bytes()),
    );
    Ok((config, CertificateHash(hash)))
}

fn event_bytes(event: &Event) -> Result<Bytes, salvo::Error> {
    Ok(Bytes::from(
        serde_json::to_vec(event).map_err(salvo::Error::other)?,
    ))
}

struct Relay {
    room: Arc<Room>,
    domain: Option<String>,
}

#[handler]
impl Relay {
    async fn handle(&self, req: &mut Request) -> Result<(), salvo::Error> {
        let origin = req
            .headers()
            .get("origin")
            .and_then(|value| value.to_str().ok());
        let allowed = self
            .domain
            .as_ref()
            .map(|domain| format!("https://{domain}"));
        if origin != allowed.as_deref()
            && !(self.domain.is_none()
                && matches!(
                    origin,
                    Some("http://localhost:5173" | "http://127.0.0.1:5173")
                ))
        {
            return Err(salvo::Error::other("Invalid origin"));
        }
        let room = &self.room;
        let session = req.web_transport_mut().await?;
        let id = room.next_id.fetch_add(1, Ordering::Relaxed);
        let mut events = room.events.subscribe();
        let snapshot = {
            let mut players = room.players.lock().unwrap();
            if players.len() >= MAX_PLAYERS {
                return Err(salvo::Error::other("Room full"));
            }
            let snapshot = players
                .iter()
                .map(|(&id, player)| Event::State {
                    id,
                    sequence: player.sequence,
                    position: player.position.clone(),
                })
                .collect::<Vec<_>>();
            players.insert(
                id,
                Player {
                    sequence: 0,
                    position: Position {
                        x: 0.0,
                        y: 0.0,
                        z: 0.0,
                        yaw: 0.0,
                        bank: 0.0,
                        speed: 0.0,
                        flying: false,
                        spread: 1.0,
                        flap: false,
                    },
                },
            );
            snapshot
        };
        let _player = PlayerGuard {
            room: room.clone(),
            id,
        };
        let session_id = session.session_id();
        let mut reader = session.datagram_reader();
        let mut sender = session.datagram_sender();
        let mut stream = session.open_uni(session_id).await?;
        stream
            .write_all(&event_bytes(&Event::Welcome { id })?)
            .await?;
        stream.shutdown().await?;
        for player in &snapshot {
            let mut stream = session.open_uni(session_id).await?;
            stream.write_all(&event_bytes(player)?).await?;
            stream.shutdown().await?;
        }
        let mut last_update = Instant::now() - StdDuration::from_secs(1);
        loop {
            tokio::select! {
                incoming = reader.read_datagram() => {
                    let Ok(datagram) = incoming else { break };
                    let payload = datagram.into_payload();
                    if payload.len() > MAX_PACKET || last_update.elapsed() < StdDuration::from_millis(40) { continue; }
                    let Ok(update) = serde_json::from_slice::<Update>(&payload) else { continue };
                    if update.v != 1 || !update.position.valid() { continue; }
                    {
                        let mut players = room.players.lock().unwrap();
                        let Some(player) = players.get_mut(&id) else { break };
                        if update.sequence <= player.sequence { continue; }
                        player.sequence = update.sequence;
                        player.position = update.position.clone();
                    }
                    last_update = Instant::now();
                    let _ = room.events.send(Event::State {
                        id, sequence: update.sequence, position: update.position,
                    });
                }
                outgoing = events.recv() => {
                    match outgoing {
                        Ok(event) => {
                            if matches!(&event, Event::State { id: sender_id, .. } if *sender_id == id) { continue; }
                            if matches!(event, Event::State { .. }) {
                                if sender.send_datagram(event_bytes(&event)?).is_err() { break; }
                            } else {
                                let mut stream = session.open_uni(session_id).await?;
                                stream.write_all(&event_bytes(&event)?).await?;
                                stream.shutdown().await?;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        }
        Ok(())
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let domain = std::env::var("FLAX3D_DOMAIN").ok();
    let mut router = Router::new().push(Router::with_path("transport").goal(Relay {
        room: Room::new(),
        domain: domain.clone(),
    }));
    if let Some(domain) = domain {
        let dist = std::env::var("FLAX3D_DIST").unwrap_or_else(|_| "dist".into());
        router = router
            .push(Router::with_path("{*path}").get(StaticDir::new([dist]).defaults("index.html")));
        let cache = std::env::var("FLAX3D_ACME_CACHE").unwrap_or_else(|_| "server/acme".into());
        let mut issuer = AcmeIssuer::builder()
            .storage(Arc::new(FileStorage::new(&cache)))
            .http01_solver(Arc::new(Http01Solver::new(80)));
        if std::env::var_os("FLAX3D_ACME_STAGING").is_some() {
            issuer = issuer.ca("https://acme-staging-v02.api.letsencrypt.org/directory");
        }
        let issuer = issuer.build();
        let cert_path = Path::new(&cache)
            .join("certificates")
            .join(issuer.issuer_key())
            .join(&domain)
            .join(format!("{domain}.crt"));
        let had_certificate = cert_path.exists();
        let mut listener = TcpListener::new("0.0.0.0:443")
            .acme()
            .cache_path(cache)
            .add_domain(domain)
            .add_issuer(Arc::new(issuer));
        if std::env::var_os("FLAX3D_ACME_STAGING").is_some() {
            listener = listener.directory(
                "staging",
                "https://acme-staging-v02.api.letsencrypt.org/directory",
            );
        }
        let listener = listener
            .http01_challenge(&mut router)
            .quinn("0.0.0.0:443")
            .join(TcpListener::new("0.0.0.0:80"))
            .bind()
            .await;
        if !had_certificate && cert_path.exists() {
            anyhow::bail!("Initial ACME certificate issued; restart to load it into the TLS cache");
        }
        Server::new(listener).serve(router).await;
    } else {
        let (config, hash) = local_certificate()?;
        router = router.push(Router::with_path("certificate-hash").get(hash));
        let listener = QuinnListener::new(config.clone(), ("127.0.0.1", 8698))
            .join(TcpListener::new(("127.0.0.1", 8698)).rustls(config))
            .join(TcpListener::new(("127.0.0.1", 8699)))
            .bind()
            .await;
        Server::new(listener).serve(router).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn position() -> Position {
        Position {
            x: 0.0,
            y: 0.0,
            z: 0.0,
            yaw: 0.0,
            bank: 0.0,
            speed: 0.0,
            flying: false,
            spread: 1.0,
            flap: false,
        }
    }

    #[test]
    fn rejects_invalid_positions() {
        assert!(position().valid());
        assert!(
            !Position {
                x: f32::NAN,
                ..position()
            }
            .valid()
        );
        assert!(
            !Position {
                spread: 1.2,
                ..position()
            }
            .valid()
        );
        assert!(
            !Position {
                x: 451.0,
                ..position()
            }
            .valid()
        );
    }

    #[test]
    fn cleans_up_player_on_exit() {
        let room = Room::new();
        room.players.lock().unwrap().insert(
            1,
            Player {
                sequence: 0,
                position: position(),
            },
        );
        {
            let _guard = PlayerGuard {
                room: room.clone(),
                id: 1,
            };
            assert_eq!(room.players.lock().unwrap().len(), 1);
        }
        assert!(room.players.lock().unwrap().is_empty());
    }
}
