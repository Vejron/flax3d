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
    time::{Duration as StdDuration, Instant, SystemTime, UNIX_EPOCH},
};
use time::{Duration, OffsetDateTime};
use tokio::io::AsyncWriteExt;
use tokio::sync::broadcast;

const MAX_PLAYERS: usize = 32;
const MAX_PACKET: usize = 512;
/// Wire schema version, mirrored by `MESSAGE_VERSION` in `src/network.ts`.
const MESSAGE_VERSION: u8 = 6;
/// Tag for a client's hit report (`[0, victimId]`), which cannot be confused with an update.
const MESSAGE_HIT: u8 = 0;
/// Tag for a client's latency probe (`[1, nonce]`), which the server echoes back as a `pong`.
const MESSAGE_PING: u8 = 1;
/// Tag for a client's pickup report (`[2, slot]`), which the server validates and rebroadcasts.
const MESSAGE_PICKUP: u8 = 2;
/// Power-up slots kept on the field. One reappears `POWERUP_RESPAWN` after it is collected.
const POWERUP_SLOTS: usize = 2;
/// Horizontal radius of the random spawn disc around the origin, in metres.
const POWERUP_SPAWN_RADIUS_M: f64 = 300.0;
/// Lowest and highest spawn altitude above the terrain, in metres.
const POWERUP_MIN_ALTITUDE_M: f64 = 13.0;
const POWERUP_MAX_ALTITUDE_M: f64 = 80.0;
/// Delay between a slot being collected and reappearing, mirroring `powerupConfig.respawnSeconds`.
const POWERUP_RESPAWN: StdDuration = StdDuration::from_secs(10);
/// Sphere a pickup is accepted within, in centimetres. Covers the client's 4 m reach plus the
/// staleness of a 20 Hz position update during a fast pass, so a fair pickup is never rejected.
const PICKUP_REACH_CM: f64 = 800.0;

/// Fixed-point wire position. Units mirror `src/network.ts` and are documented in NETWORKING.md.
///
/// One shape carries both vehicle kinds so the relay stays a single code path: the fields a kind
/// does not use are simply zero. Field order is positional and must match `encodePosition` exactly.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct Position {
    /// Centimetres.
    x: i32,
    y: i32,
    z: i32,
    /// Milliradians, wrapped to `[-π, π)` by the sender. Hull heading, for a tank.
    yaw: i16,
    /// Vehicle kind: 0 = bird, 1 = tank.
    kind: u8,
    /// Milliradians. Bird only.
    bank: i16,
    /// Centimetres per second. Signed, so a tank can reverse.
    speed: i16,
    flying: bool,
    /// Milli-units in `0..=1000`. Bird only.
    spread: u16,
    flap: bool,
    /// Bird shoulder angles in milliradians.
    wing_left: i16,
    wing_right: i16,
    /// Tank turret bearing relative to the hull, in milliradians.
    turret_yaw: i16,
    /// Tank turret elevation in milliradians; negative depresses the barrel.
    turret_pitch: i16,
    /// Tank hull slope adopted from the terrain, in milliradians.
    hull_pitch: i16,
    hull_roll: i16,
    /// True while the sender is holding the trigger. Relayed so peers can play a cosmetic shot.
    fire: bool,
    /// Hit points in `0..=100`. Owned by the sender's client; the server only relays it.
    health: u8,
}

impl Position {
    fn valid(&self) -> bool {
        self.x.abs() <= 45_000
            && self.z.abs() <= 45_000
            && (-5_000..=30_000).contains(&self.y)
            && self.yaw.abs() <= 4_000
            && self.kind <= 1
            && self.bank.abs() <= 1_000
            && (-2_000..=10_000).contains(&self.speed)
            && self.spread <= 1_000
            && self.wing_left.abs() <= 2_000
            && self.wing_right.abs() <= 2_000
            && self.turret_yaw.abs() <= 4_000
            && (-1_000..=2_000).contains(&self.turret_pitch)
            && self.hull_pitch.abs() <= 2_000
            && self.hull_roll.abs() <= 2_000
            && self.health <= 100
    }
}

impl Default for Position {
    fn default() -> Self {
        Self {
            x: 0,
            y: 0,
            z: 0,
            yaw: 0,
            kind: 0,
            bank: 0,
            speed: 0,
            flying: false,
            spread: 1_000,
            flap: false,
            wing_left: 0,
            wing_right: 0,
            turret_yaw: 0,
            turret_pitch: 0,
            hull_pitch: 0,
            hull_roll: 0,
            fire: false,
            health: 100,
        }
    }
}

/// Client update: `[version, sequence, position]` as a MessagePack array. A hit report is
/// `[MESSAGE_HIT, victim]`; the two shapes are disjoint, so decoding tries the update first.
#[derive(Deserialize)]
struct Update(u8, u32, Position);

/// A relayed event, encoded once at construction. `Bytes` clones by refcount, so every subscriber
/// writes the same buffer instead of re-serialising the event once per recipient.
#[derive(Clone)]
struct Event {
    kind: EventKind,
    id: u64,
    bytes: Bytes,
}

#[derive(Clone, Copy)]
enum EventKind {
    Welcome,
    State,
    Leave,
    Hit,
    /// A power-up appeared (or reappeared) at a world position.
    PowerupSpawn,
    /// A player collected a power-up.
    PowerupTaken,
}

impl Event {
    fn welcome(id: u64) -> Result<Self, salvo::Error> {
        Self::encode(EventKind::Welcome, id, &(EVENT_WELCOME, id))
    }

    fn state(id: u64, sequence: u32, position: Position) -> Result<Self, salvo::Error> {
        Self::encode(EventKind::State, id, &(EVENT_STATE, id, sequence, position))
    }

    fn leave(id: u64) -> Result<Self, salvo::Error> {
        Self::encode(EventKind::Leave, id, &(EVENT_LEAVE, id))
    }

    /// `id` is the shooter, `victim` the player it claims to have hit.
    fn hit(id: u64, victim: u64) -> Result<Self, salvo::Error> {
        Self::encode(EventKind::Hit, id, &(EVENT_HIT, id, victim))
    }

    /// A power-up appearing at a world position (centimetres). Global rather than player-scoped, so
    /// `id` is 0 — never a real player id — and the sender filter can never suppress it.
    fn powerup_spawn(slot: u8, x: i32, y: i32, z: i32) -> Result<Self, salvo::Error> {
        Self::encode(EventKind::PowerupSpawn, 0, &(EVENT_POWERUP_SPAWN, slot, x, y, z))
    }

    /// `taker` collected power-up `slot`. Keeps `id = taker` so the collector receives it too and
    /// can credit its own magazine, while everyone else simply clears the pickup from the field.
    fn powerup_taken(slot: u8, taker: u64) -> Result<Self, salvo::Error> {
        Self::encode(EventKind::PowerupTaken, taker, &(EVENT_POWERUP_TAKEN, slot, taker))
    }

    fn encode(kind: EventKind, id: u64, value: &impl Serialize) -> Result<Self, salvo::Error> {
        let bytes = rmp_serde::to_vec(value).map_err(salvo::Error::other)?;
        Ok(Self { kind, id, bytes: Bytes::from(bytes) })
    }
}

const EVENT_WELCOME: u8 = 0;
const EVENT_STATE: u8 = 1;
const EVENT_LEAVE: u8 = 2;
const EVENT_HIT: u8 = 3;
const EVENT_PONG: u8 = 4;
const EVENT_POWERUP_SPAWN: u8 = 5;
const EVENT_POWERUP_TAKEN: u8 = 6;

#[derive(Clone)]
struct Player {
    sequence: u32,
    position: Position,
}

/// One power-up slot. `respawn_at` is only meaningful while `active` is false.
#[derive(Clone, Copy)]
struct PowerupSlot {
    active: bool,
    x: i32,
    y: i32,
    z: i32,
    respawn_at: Option<Instant>,
}

/// Tiny xorshift64* generator. Dependency-free on purpose: adding `rand` (or the `tokio` `time`
/// feature for a respawn timer) would invalidate the Docker dependency layer for no benefit.
struct Rng(u64);

impl Rng {
    fn from_seed(seed: u64) -> Self {
        // A zero state would be a fixed point, so force it non-zero.
        Self(seed | 1)
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    /// Uniform in `[0, 1)`.
    fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    fn range(&mut self, low: f64, high: f64) -> f64 {
        low + self.next_f64() * (high - low)
    }
}

/// Terrain height in metres, mirroring `terrainHeight` in `src/terrain.ts`. The client renders the
/// same field, so the two formulas must stay in step; `terrain_height_matches_the_client` pins it.
fn terrain_height(x: f64, z: f64) -> f64 {
    let rolling = ((z + 80.0) * 0.018).cos() - (80.0_f64 * 0.018).cos();
    let rolling = rolling * (x * 0.012).cos() * 15.0;
    let crossing = (x * 0.014).sin() * (z * 0.012).cos() * 11.0;
    let detail = (z * 0.041 + x * 0.013).sin() * 2.3;
    let distance = (x.hypot(z) / 40.0).min(1.0);
    (rolling + crossing + detail) * (0.15 + 0.85 * distance * distance)
}

/// Picks a fresh power-up position: a uniform point in the spawn disc, 13..80 m above the terrain.
fn random_powerup(rng: &mut Rng) -> (i32, i32, i32) {
    // Square-rooting the radius spreads points evenly over the area instead of clumping at the hub.
    let angle = rng.range(0.0, std::f64::consts::TAU);
    let radius = POWERUP_SPAWN_RADIUS_M * rng.next_f64().sqrt();
    let x = angle.cos() * radius;
    let z = angle.sin() * radius;
    let y = terrain_height(x, z) + rng.range(POWERUP_MIN_ALTITUDE_M, POWERUP_MAX_ALTITUDE_M);
    (
        (x * 100.0).round() as i32,
        (y * 100.0).round() as i32,
        (z * 100.0).round() as i32,
    )
}

struct Room {
    next_id: AtomicU64,
    players: Mutex<HashMap<u64, Player>>,
    events: broadcast::Sender<Event>,
    /// The power-up field. The server owns where each slot sits and when it comes back.
    powerups: Mutex<[PowerupSlot; POWERUP_SLOTS]>,
    /// Shared spawn-position generator (see `Rng`).
    rng: Mutex<Rng>,
}

struct PlayerGuard {
    room: Arc<Room>,
    id: u64,
}

impl Drop for PlayerGuard {
    fn drop(&mut self) {
        self.room.players.lock().unwrap().remove(&self.id);
        if let Ok(leave) = Event::leave(self.id) {
            let _ = self.room.events.send(leave);
        }
    }
}

impl Room {
    fn new() -> Arc<Self> {
        let (events, _) = broadcast::channel(256);
        let seed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos() as u64)
            .unwrap_or(0x9e37_79b9_7f4a_7c15);
        let mut rng = Rng::from_seed(seed);
        // Both slots start on the field, so the match opens with two pickups available.
        let powerups = std::array::from_fn(|_| {
            let (x, y, z) = random_powerup(&mut rng);
            PowerupSlot { active: true, x, y, z, respawn_at: None }
        });
        Arc::new(Self {
            next_id: AtomicU64::new(1),
            players: Mutex::new(HashMap::new()),
            events,
            powerups: Mutex::new(powerups),
            rng: Mutex::new(rng),
        })
    }
}

/// Applies a pickup claim: true when `slot` is active and `player` is within reach, in which case
/// the slot is cleared and armed for respawn. The first valid claim wins, so a racing peer's later
/// report finds the slot inactive and is refused.
fn claim_powerup(room: &Room, slot: usize, player: &Player) -> bool {
    // A player that has not sent an update yet still sits at the default position and must not
    // collect whatever happens to be near it.
    if player.sequence == 0 || slot >= POWERUP_SLOTS {
        return false;
    }
    let mut powerups = room.powerups.lock().unwrap();
    let entry = &mut powerups[slot];
    if !entry.active {
        return false;
    }
    let dx = (entry.x - player.position.x) as f64;
    let dy = (entry.y - player.position.y) as f64;
    let dz = (entry.z - player.position.z) as f64;
    if dx * dx + dy * dy + dz * dz > PICKUP_REACH_CM * PICKUP_REACH_CM {
        return false;
    }
    entry.active = false;
    entry.respawn_at = Some(Instant::now() + POWERUP_RESPAWN);
    true
}

/// Brings any expired slot back at a fresh position and tells everyone. Called from the update path
/// rather than a timer, so the server needs no background task and no `tokio` `time` feature.
fn sweep_powerups(room: &Room) {
    let mut rng = room.rng.lock().unwrap();
    let mut powerups = room.powerups.lock().unwrap();
    for index in 0..POWERUP_SLOTS {
        let slot = &mut powerups[index];
        if slot.active {
            continue;
        }
        // Compare forwards (`now >= deadline`) rather than calling `elapsed()`, which would panic
        // on an instant that is still in the future.
        match slot.respawn_at {
            Some(deadline) if Instant::now() >= deadline => {}
            _ => continue,
        }
        let (x, y, z) = random_powerup(&mut rng);
        slot.active = true;
        slot.x = x;
        slot.y = y;
        slot.z = z;
        slot.respawn_at = None;
        if let Ok(event) = Event::powerup_spawn(index as u8, x, y, z) {
            let _ = room.events.send(event);
        }
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
                .collect::<Result<Vec<_>, _>>()?;
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
        let welcome = Event::welcome(id)?;
        let mut stream = session.open_uni(session_id).await?;
        stream.write_all(&welcome.bytes).await?;
        stream.shutdown().await?;
        for event in &snapshot {
            let mut stream = session.open_uni(session_id).await?;
            stream.write_all(&event.bytes).await?;
            stream.shutdown().await?;
        }
        // A newcomer also needs the current power-up field, since spawn events only fire on change.
        let powerup_snapshot = {
            let powerups = room.powerups.lock().unwrap();
            powerups
                .iter()
                .enumerate()
                .filter(|(_, slot)| slot.active)
                .map(|(index, slot)| Event::powerup_spawn(index as u8, slot.x, slot.y, slot.z))
                .collect::<Result<Vec<_>, _>>()?
        };
        for event in &powerup_snapshot {
            let mut stream = session.open_uni(session_id).await?;
            stream.write_all(&event.bytes).await?;
            stream.shutdown().await?;
        }
        let mut last_update = Instant::now() - StdDuration::from_secs(1);
        let mut last_hit = Instant::now() - StdDuration::from_secs(1);
        let mut last_ping = Instant::now() - StdDuration::from_secs(1);
        let mut last_pickup = Instant::now() - StdDuration::from_secs(1);
        loop {
            tokio::select! {
                incoming = reader.read_datagram() => {
                    let Ok(datagram) = incoming else { break };
                    let payload = datagram.into_payload();
                    if payload.len() > MAX_PACKET { continue; }
                    if let Ok(update) = rmp_serde::from_slice::<Update>(&payload) {
                        if last_update.elapsed() < StdDuration::from_millis(25) { continue; }
                        if update.0 != MESSAGE_VERSION || !update.2.valid() { continue; }
                        {
                            let mut players = room.players.lock().unwrap();
                            let Some(player) = players.get_mut(&id) else { break };
                            if update.1 <= player.sequence { continue; }
                            player.sequence = update.1;
                            player.position = update.2.clone();
                        }
                        last_update = Instant::now();
                        let _ = room.events.send(Event::state(id, update.1, update.2)?);
                        // Piggyback the respawn schedule on the update stream, so no timer is needed.
                        sweep_powerups(room);
                    } else if let Ok((tag, value)) = rmp_serde::from_slice::<(u8, u64)>(&payload) {
                        // Both control messages are two-element `[tag, value]` arrays, so they share
                        // a decode and are told apart by tag. Each gets its own throttle rather than
                        // sharing the 20 Hz update budget.
                        if tag == MESSAGE_HIT {
                            // The victim must still be in the room.
                            if last_hit.elapsed() < StdDuration::from_millis(25) { continue; }
                            if value == id || !room.players.lock().unwrap().contains_key(&value) { continue; }
                            last_hit = Instant::now();
                            let _ = room.events.send(Event::hit(id, value)?);
                        } else if tag == MESSAGE_PING {
                            // Latency probe: echo the nonce straight back on a datagram. No timing
                            // is kept server-side, so the client measures the whole round trip.
                            if last_ping.elapsed() < StdDuration::from_millis(25) { continue; }
                            last_ping = Instant::now();
                            let pong = rmp_serde::to_vec(&(EVENT_PONG, value)).map_err(salvo::Error::other)?;
                            if sender.send_datagram(Bytes::from(pong)).is_err() { break; }
                        } else if tag == MESSAGE_PICKUP {
                            if last_pickup.elapsed() < StdDuration::from_millis(25) { continue; }
                            last_pickup = Instant::now();
                            let Some(index) = usize::try_from(value).ok().filter(|slot| *slot < POWERUP_SLOTS) else { continue };
                            // Validate the claim against the sender's last known position, so a
                            // client cannot collect a power-up it is nowhere near.
                            let player = {
                                let players = room.players.lock().unwrap();
                                players.get(&id).cloned()
                            };
                            let Some(player) = player else { break };
                            if claim_powerup(room, index, &player) {
                                let _ = room.events.send(Event::powerup_taken(index as u8, id)?);
                            }
                        }
                    }
                }
                outgoing = events.recv() => {
                    match outgoing {
                        Ok(event) => {
                            if event.id == id && matches!(event.kind, EventKind::State | EventKind::Hit) { continue; }
                            if matches!(event.kind, EventKind::State) {
                                // Encoded once at construction, so every peer writes the same buffer.
                                if sender.send_datagram(event.bytes.clone()).is_err() { break; }
                            } else {
                                let mut stream = session.open_uni(session_id).await?;
                                stream.write_all(&event.bytes).await?;
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
        assert!(!Position { kind: 2, ..position() }.valid());
        assert!(!Position { bank: 1_001, ..position() }.valid());
        assert!(!Position { speed: 10_001, ..position() }.valid());
        assert!(!Position { speed: -2_001, ..position() }.valid());
        assert!(!Position { spread: 1_001, ..position() }.valid());
        assert!(!Position { wing_left: -2_001, ..position() }.valid());
        assert!(!Position { wing_right: 2_001, ..position() }.valid());
        assert!(!Position { turret_yaw: -4_001, ..position() }.valid());
        assert!(!Position { turret_pitch: 2_001, ..position() }.valid());
        assert!(!Position { turret_pitch: -1_001, ..position() }.valid());
        assert!(!Position { hull_pitch: 2_001, ..position() }.valid());
        assert!(!Position { hull_roll: -2_001, ..position() }.valid());
        assert!(!Position { health: 101, ..position() }.valid());
        // A reversing tank is legal: the speed field is signed.
        assert!(Position { speed: -500, kind: 1, ..position() }.valid());
    }

    /// Byte-for-byte fixture emitted by `encodeUpdate` in `src/network.ts`. If this breaks, the two
    /// languages have drifted apart.
    #[test]
    fn decodes_a_client_update_fixture() {
        let fixture: &[u8] = &[
            147, 6, 7, 220, 0, 18, 205, 4, 210, 209, 238, 58, 205, 3, 132, 205, 6, 35, 0, 209,
            254, 32, 205, 5, 220, 195, 205, 3, 232, 194, 209, 255, 6, 205, 3, 82, 0, 0, 0, 0,
            195, 100,
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
                kind: 0,
                bank: -480,
                speed: 1_500,
                flying: true,
                spread: 1_000,
                flap: false,
                wing_left: -250,
                wing_right: 850,
                turret_yaw: 0,
                turret_pitch: 0,
                hull_pitch: 0,
                hull_roll: 0,
                fire: true,
                health: 100,
            }
        );
        assert!(position.valid());
    }

    /// The tank counterpart of the fixture above, emitted by `encodeTankUpdate` in `src/network.ts`.
    #[test]
    fn decodes_a_client_tank_fixture() {
        let fixture: &[u8] = &[
            147, 6, 9, 220, 0, 18, 205, 8, 2, 205, 1, 69, 209, 240, 21, 209, 251, 80, 1, 0, 209,
            254, 162, 194, 205, 3, 232, 194, 0, 0, 205, 2, 88, 205, 1, 94, 120, 208, 186, 195,
            100,
        ];
        let Update(version, sequence, position) = rmp_serde::from_slice(fixture).unwrap();
        assert_eq!(version, MESSAGE_VERSION);
        assert_eq!(sequence, 9);
        assert_eq!(position.kind, 1);
        assert_eq!(position.speed, -350);
        assert_eq!(position.turret_yaw, 600);
        assert_eq!(position.turret_pitch, 350);
        assert_eq!(position.hull_pitch, 120);
        assert_eq!(position.hull_roll, -70);
        assert!(position.valid());
    }

    #[test]
    fn encodes_events_as_tagged_arrays() {
        let welcome = Event::welcome(4).unwrap().bytes;
        assert_eq!(rmp_serde::from_slice::<(u8, u64)>(&welcome).unwrap(), (EVENT_WELCOME, 4));

        let leave = Event::leave(4).unwrap().bytes;
        assert_eq!(rmp_serde::from_slice::<(u8, u64)>(&leave).unwrap(), (EVENT_LEAVE, 4));

        let state = Event::state(9, 3, position()).unwrap().bytes;
        let (kind, id, sequence, decoded) =
            rmp_serde::from_slice::<(u8, u64, u32, Position)>(&state).unwrap();
        assert_eq!((kind, id, sequence), (EVENT_STATE, 9, 3));
        assert_eq!(decoded, position());
        assert!(state.len() < 64);
    }

    /// Relaying an event to many peers must not re-serialise it: cloning shares one buffer.
    #[test]
    fn cloning_an_event_shares_the_encoded_buffer() {
        let event = Event::state(9, 3, position()).unwrap();
        let clone = event.clone();
        assert_eq!(clone.bytes.as_ptr(), event.bytes.as_ptr());
    }

    #[test]
    fn encodes_hit_events_with_the_shooter_stamped() {
        let bytes = Event::hit(4, 9).unwrap().bytes;
        let (kind, shooter, victim) = rmp_serde::from_slice::<(u8, u64, u64)>(&bytes).unwrap();
        assert_eq!((kind, shooter, victim), (EVENT_HIT, 4, 9));
        assert!(bytes.len() < 32);
    }

    #[test]
    fn echoes_a_ping_as_a_pong_with_the_same_nonce() {
        let pong = rmp_serde::to_vec(&(EVENT_PONG, 7u64)).unwrap();
        assert_eq!(rmp_serde::from_slice::<(u8, u64)>(&pong).unwrap(), (EVENT_PONG, 7));
        assert!(pong.len() < 16);
    }

    #[test]
    fn encodes_powerup_events() {
        let spawn = Event::powerup_spawn(1, 1_200, 4_500, -300).unwrap().bytes;
        let (kind, slot, x, y, z) =
            rmp_serde::from_slice::<(u8, u8, i32, i32, i32)>(&spawn).unwrap();
        assert_eq!((kind, slot), (EVENT_POWERUP_SPAWN, 1));
        assert_eq!((x, y, z), (1_200, 4_500, -300));
        assert!(spawn.len() < 32);

        let taken = Event::powerup_taken(0, 7).unwrap().bytes;
        let (kind, slot, taker) = rmp_serde::from_slice::<(u8, u8, u64)>(&taken).unwrap();
        assert_eq!((kind, slot, taker), (EVENT_POWERUP_TAKEN, 0, 7));
        assert!(taken.len() < 16);
    }

    /// Pins the Rust terrain formula to the values `src/terrain.ts` produces for the same inputs.
    #[test]
    fn terrain_height_matches_the_client() {
        let cases = [
            (0.0, 0.0, 0.0),
            (120.0, -250.0, -14.572_022_318),
            (-300.0, 150.0, 8.651_512_009),
            (42.5, 88.25, -13.666_161_979),
        ];
        for (x, z, expected) in cases {
            assert!(
                (terrain_height(x, z) - expected).abs() < 1e-6,
                "terrain_height({x}, {z}) drifted from the client formula"
            );
        }
    }

    #[test]
    fn powerup_spawns_stay_over_the_area() {
        let mut rng = Rng::from_seed(12_345);
        for _ in 0..500 {
            let (x, y, z) = random_powerup(&mut rng);
            let (xm, zm) = (f64::from(x) / 100.0, f64::from(z) / 100.0);
            assert!(xm.hypot(zm) <= POWERUP_SPAWN_RADIUS_M + 0.5);
            let altitude = f64::from(y) / 100.0 - terrain_height(xm, zm);
            assert!(
                (POWERUP_MIN_ALTITUDE_M - 0.5..=POWERUP_MAX_ALTITUDE_M + 0.5).contains(&altitude),
                "altitude {altitude} m is outside the 13..80 m band"
            );
        }
    }

    #[test]
    fn a_taken_slot_respawns_only_once_its_delay_has_passed() {
        let room = Room::new();
        assert!(room.powerups.lock().unwrap().iter().all(|slot| slot.active));
        {
            let mut powerups = room.powerups.lock().unwrap();
            powerups[0].active = false;
            powerups[0].respawn_at = Some(Instant::now() + POWERUP_RESPAWN);
        }
        sweep_powerups(&room);
        assert!(!room.powerups.lock().unwrap()[0].active, "a slot reappeared before its delay");

        {
            let mut powerups = room.powerups.lock().unwrap();
            powerups[0].respawn_at = Some(Instant::now() - StdDuration::from_millis(1));
        }
        sweep_powerups(&room);
        let powerups = room.powerups.lock().unwrap();
        assert!(powerups[0].active, "a due slot did not come back");
        assert!(powerups[0].respawn_at.is_none());
    }

    #[test]
    fn pickup_claims_need_an_active_slot_and_a_nearby_player() {
        let room = Room::new();
        let at = |x: i32, y: i32, z: i32, sequence: u32| Player {
            sequence,
            position: Position { x, y, z, ..Position::default() },
        };
        let (x, y, z) = {
            let powerups = room.powerups.lock().unwrap();
            (powerups[0].x, powerups[0].y, powerups[0].z)
        };

        // A player that has not reported a position yet cannot collect anything.
        assert!(!claim_powerup(&room, 0, &at(x, y, z, 0)));
        // A player right on the pickup wins it.
        assert!(claim_powerup(&room, 0, &at(x, y, z, 1)));
        // The slot is now inactive, so a racing peer's claim is refused rather than double-paid.
        assert!(!claim_powerup(&room, 0, &at(x, y, z, 1)));
        // Even an active slot is out of reach from far away.
        assert!(!claim_powerup(&room, 1, &at(x + 5_000, y, z, 1)));
        // And a slot index past the end is refused instead of panicking.
        assert!(!claim_powerup(&room, POWERUP_SLOTS, &at(x, y, z, 1)));
    }

    #[test]
    fn hit_reports_and_position_updates_decode_apart() {
        let hit = rmp_serde::to_vec(&(MESSAGE_HIT, 9u64)).unwrap();
        assert_eq!(rmp_serde::from_slice::<(u8, u64)>(&hit).unwrap(), (MESSAGE_HIT, 9));
        assert!(rmp_serde::from_slice::<Update>(&hit).is_err());

        // A ping is the same two-field shape as a hit, told apart only by the tag.
        let ping = rmp_serde::to_vec(&(MESSAGE_PING, 3u64)).unwrap();
        assert_eq!(rmp_serde::from_slice::<(u8, u64)>(&ping).unwrap(), (MESSAGE_PING, 3));
        assert!(rmp_serde::from_slice::<Update>(&ping).is_err());

        // A pickup report is the same two-field shape again, told apart only by the tag.
        let pickup = rmp_serde::to_vec(&(MESSAGE_PICKUP, 1u64)).unwrap();
        assert_eq!(rmp_serde::from_slice::<(u8, u64)>(&pickup).unwrap(), (MESSAGE_PICKUP, 1));
        assert!(rmp_serde::from_slice::<Update>(&pickup).is_err());

        let update = rmp_serde::to_vec(&(MESSAGE_VERSION, 1u32, Position::default())).unwrap();
        assert!(rmp_serde::from_slice::<Update>(&update).is_ok());
        assert!(rmp_serde::from_slice::<(u8, u64)>(&update).is_err());
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
