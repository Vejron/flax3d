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
/// Wire schema version, mirrored by `MESSAGE_VERSION` in `src/network.ts`.
const MESSAGE_VERSION: u8 = 4;

/// Fixed-point wire position. Units mirror `src/network.ts` and are documented in NETWORKING.md.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct Position {
    /// Centimetres.
    x: i32,
    y: i32,
    z: i32,
    /// Milliradians, wrapped to `[-π, π)` by the sender.
    yaw: i16,
    /// Milliradians.
    bank: i16,
    /// Centimetres per second.
    speed: u16,
    flying: bool,
    /// Milli-units in `0..=1000`.
    spread: u16,
    flap: bool,
    /// Shoulder angles in milliradians.
    wing_left: i16,
    wing_right: i16,
    /// True while the sender is holding the trigger. Relayed so peers can play a cosmetic shot.
    fire: bool,
}

impl Position {
    fn valid(&self) -> bool {
        self.x.abs() <= 45_000
            && self.z.abs() <= 45_000
            && (-5_000..=30_000).contains(&self.y)
            && self.yaw.abs() <= 4_000
            && self.bank.abs() <= 1_000
            && self.speed <= 10_000
            && self.spread <= 1_000
            && self.wing_left.abs() <= 2_000
            && self.wing_right.abs() <= 2_000
    }
}

impl Default for Position {
    fn default() -> Self {
        Self {
            x: 0,
            y: 0,
            z: 0,
            yaw: 0,
            bank: 0,
            speed: 0,
            flying: false,
            spread: 1_000,
            flap: false,
            wing_left: 0,
            wing_right: 0,
            fire: false,
        }
    }
}

/// Client update: `[version, sequence, position]` as a MessagePack array.
#[derive(Deserialize)]
struct Update(u8, u32, Position);

#[derive(Clone)]
struct Event {
    kind: EventKind,
    id: u64,
    sequence: u32,
    position: Position,
}

#[derive(Clone, Copy)]
enum EventKind {
    Welcome,
    State,
    Leave,
}

impl Event {
    fn welcome(id: u64) -> Self {
        Self { kind: EventKind::Welcome, id, sequence: 0, position: Position::default() }
    }

    fn state(id: u64, sequence: u32, position: Position) -> Self {
        Self { kind: EventKind::State, id, sequence, position }
    }

    fn leave(id: u64) -> Self {
        Self { kind: EventKind::Leave, id, sequence: 0, position: Position::default() }
    }
}

const EVENT_WELCOME: u8 = 0;
const EVENT_STATE: u8 = 1;
const EVENT_LEAVE: u8 = 2;

fn event_bytes(event: &Event) -> Result<Bytes, salvo::Error> {
    let bytes = match event.kind {
        EventKind::Welcome => rmp_serde::to_vec(&(EVENT_WELCOME, event.id)),
        EventKind::State => {
            rmp_serde::to_vec(&(EVENT_STATE, event.id, event.sequence, &event.position))
        }
        EventKind::Leave => rmp_serde::to_vec(&(EVENT_LEAVE, event.id)),
    }
    .map_err(salvo::Error::other)?;
    Ok(Bytes::from(bytes))
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
        let _ = self.room.events.send(Event::leave(self.id));
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
                .map(|(&id, player)| {
                    Event::state(id, player.sequence, player.position.clone())
                })
                .collect::<Vec<_>>();
            players.insert(
                id,
                Player {
                    sequence: 0,
                    position: Position::default(),
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
            .write_all(&event_bytes(&Event::welcome(id))?)
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
                    if payload.len() > MAX_PACKET || last_update.elapsed() < StdDuration::from_millis(25) { continue; }
                    let Ok(update) = rmp_serde::from_slice::<Update>(&payload) else { continue };
                    if update.0 != MESSAGE_VERSION || !update.2.valid() { continue; }
                    {
                        let mut players = room.players.lock().unwrap();
                        let Some(player) = players.get_mut(&id) else { break };
                        if update.1 <= player.sequence { continue; }
                        player.sequence = update.1;
                        player.position = update.2.clone();
                    }
                    last_update = Instant::now();
                    let _ = room.events.send(Event::state(id, update.1, update.2));
                }
                outgoing = events.recv() => {
                    match outgoing {
                        Ok(event) => {
                            if event.id == id && matches!(event.kind, EventKind::State) { continue; }
                            if matches!(event.kind, EventKind::State) {
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
        Position::default()
    }

    #[test]
    fn rejects_out_of_range_positions() {
        assert!(position().valid());
        assert!(!Position { x: 45_001, ..position() }.valid());
        assert!(!Position { z: -45_001, ..position() }.valid());
        assert!(!Position { y: -5_001, ..position() }.valid());
        assert!(!Position { yaw: 4_001, ..position() }.valid());
        assert!(!Position { bank: 1_001, ..position() }.valid());
        assert!(!Position { speed: 10_001, ..position() }.valid());
        assert!(!Position { spread: 1_001, ..position() }.valid());
        assert!(!Position { wing_left: -2_001, ..position() }.valid());
        assert!(!Position { wing_right: 2_001, ..position() }.valid());
    }

    /// Byte-for-byte fixture emitted by `encodeUpdate` in `src/network.ts`. If this breaks, the two
    /// languages have drifted apart.
    #[test]
    fn decodes_a_client_update_fixture() {
        let fixture: &[u8] = &[
            147, 4, 7, 156, 205, 4, 210, 209, 238, 58, 205, 3, 132, 205, 6, 35, 209, 254, 32, 205,
            5, 220, 195, 205, 3, 232, 194, 209, 255, 6, 205, 3, 82, 195,
        ];
        let Update(version, sequence, position) = rmp_serde::from_slice(fixture).unwrap();
        assert_eq!(version, MESSAGE_VERSION);
        assert_eq!(sequence, 7);
        assert_eq!(
            position,
            Position {
                x: 1_234,
                y: -4_550,
                z: 900,
                yaw: 1_571,
                bank: -480,
                speed: 1_500,
                flying: true,
                spread: 1_000,
                flap: false,
                wing_left: -250,
                wing_right: 850,
                fire: true,
            }
        );
        assert!(position.valid());
    }

    #[test]
    fn encodes_events_as_tagged_arrays() {
        let welcome = event_bytes(&Event::welcome(4)).unwrap();
        assert_eq!(rmp_serde::from_slice::<(u8, u64)>(&welcome).unwrap(), (EVENT_WELCOME, 4));

        let leave = event_bytes(&Event::leave(4)).unwrap();
        assert_eq!(rmp_serde::from_slice::<(u8, u64)>(&leave).unwrap(), (EVENT_LEAVE, 4));

        let state = event_bytes(&Event::state(9, 3, position())).unwrap();
        let (kind, id, sequence, decoded) =
            rmp_serde::from_slice::<(u8, u64, u32, Position)>(&state).unwrap();
        assert_eq!((kind, id, sequence), (EVENT_STATE, 9, 3));
        assert_eq!(decoded, position());
        assert!(state.len() < 64);
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
