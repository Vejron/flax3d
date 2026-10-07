import * as THREE from 'three'
import { createGun, type Gun } from './weapon'

/**
 * Mesh factories for every vehicle the game can spawn. Kept free of world, network and simulation
 * state so both the bird rig and the tank rig can build the same avatars — including the clones used
 * for remote peers, which must look identical no matter which vehicle the local player has.
 *
 * Two conventions are shared by every factory, and both matter to the rigs:
 *  - the model faces -Z, so a rig sets `group.rotation.y = -yaw`;
 *  - the gun's muzzle marker is an object named `muzzle`, which is how remote rigs find the point to
 *    spawn a peer's cosmetic shot from.
 */

/** One wing's animated joints, plus which side of the body it is on. */
export interface WingRig {
    shoulder: THREE.Group
    elbow: THREE.Group
    side: number
}

export interface FlyerRig {
    group: THREE.Group
    head: THREE.Group
    /**
     * Shoulders are children 2 and 3 of `group`; the remote rig indexes them positionally, so never
     * add another part before them.
     */
    wings: WingRig[]
    gun: Gun
    dispose: () => void
}

/** Builds the bird: body, head, two wings and the back-mounted gun. */
export function buildFlyer(): FlyerRig {
    const flyer = new THREE.Group()
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: '#f7eee1', roughness: 0.62, side: THREE.DoubleSide })
    const wingMaterial = new THREE.MeshStandardMaterial({ color: '#d76748', roughness: 0.8, side: THREE.DoubleSide })
    const featherMaterial = new THREE.MeshStandardMaterial({ color: '#b95743', roughness: 0.85, side: THREE.DoubleSide })
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.45, 2.3, 5), bodyMaterial)
    body.rotation.x = -Math.PI / 2
    flyer.add(body)
    const head = new THREE.Group()
    head.position.set(0, 0.25, -0.65)
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.38, 12, 8), bodyMaterial)
    skull.position.set(0, 0.22, -0.2)
    head.add(skull)
    const beakMaterial = new THREE.MeshStandardMaterial({ color: '#efb669', roughness: 0.7 })
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.62, 5), beakMaterial)
    beak.rotation.x = -Math.PI / 2
    beak.position.set(0, 0.14, -0.62)
    head.add(beak)
    const eyeMaterial = new THREE.MeshStandardMaterial({ color: '#273c35', roughness: 0.4 })
    for (const side of [-1, 1]) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), eyeMaterial)
        eye.position.set(side * 0.31, 0.29, -0.34)
        head.add(eye)
    }
    flyer.add(head)
    const wings: WingRig[] = []
    for (const side of [-1, 1]) {
        const innerShape = new THREE.Shape()
        innerShape.moveTo(0, -0.12)
        innerShape.lineTo(side * 0.55, -0.32)
        innerShape.lineTo(side * 1.45, -0.12)
        innerShape.lineTo(side * 1.45, 0.58)
        innerShape.lineTo(side * 1.22, 0.74)
        innerShape.lineTo(side * 1.12, 0.65)
        innerShape.lineTo(side * 0.85, 0.88)
        innerShape.lineTo(side * 0.76, 0.71)
        innerShape.lineTo(side * 0.46, 0.85)
        innerShape.lineTo(0, 0.48)
        const innerGeometry = new THREE.ShapeGeometry(innerShape)
        innerGeometry.rotateX(Math.PI / 2)

        const outerShape = new THREE.Shape()
        outerShape.moveTo(0, 0)
        outerShape.lineTo(side * 0.65, -0.18)
        outerShape.lineTo(side * 1.54, 0.04)
        outerShape.lineTo(side * 1.75, 0.3)
        outerShape.lineTo(side * 1.49, 0.35)
        outerShape.lineTo(side * 1.62, 0.58)
        outerShape.lineTo(side * 1.28, 0.53)
        outerShape.lineTo(side * 1.32, 0.78)
        outerShape.lineTo(side * 0.98, 0.61)
        outerShape.lineTo(side * 0.91, 0.84)
        outerShape.lineTo(side * 0.61, 0.62)
        outerShape.lineTo(0, 0.7)
        const outerGeometry = new THREE.ShapeGeometry(outerShape)
        outerGeometry.rotateX(Math.PI / 2)

        const shoulder = new THREE.Group()
        shoulder.position.set(side * 0.18, 0, -0.5)
        shoulder.add(new THREE.Mesh(innerGeometry, wingMaterial))
        const elbow = new THREE.Group()
        elbow.position.set(side * 1.45, 0, -0.62)
        elbow.add(new THREE.Mesh(outerGeometry, featherMaterial))
        shoulder.add(elbow)
        wings.push({ shoulder, elbow, side })
        flyer.add(shoulder)
    }
    // The gun is added last so the wing shoulder groups keep their child indices.
    const gun = createGun(flyer)

    return {
        group: flyer,
        head,
        wings,
        gun,
        dispose() {
            gun.dispose()
            flyer.traverse((object) => {
                if (object instanceof THREE.Mesh) object.geometry.dispose()
            })
            flyer.removeFromParent()
            ;[bodyMaterial, wingMaterial, featherMaterial, beakMaterial, eyeMaterial].forEach((material) => material.dispose())
        },
    }
}

export interface TankRig {
    group: THREE.Group
    /** Rotating this group is what aims the gun; named so remote rigs can find it on a clone. */
    turret: THREE.Group
    muzzle: THREE.Object3D
    dispose: () => void
}

/**
 * Builds the AA tank: a tracked hull with a rotating turret on top. The turret carries the barrel and
 * the muzzle marker, so pitching and yawing the turret moves the gun independently of the hull.
 */
export function buildTank(): TankRig {
    const group = new THREE.Group()
    const armor = new THREE.MeshStandardMaterial({ color: '#6c7a5c', roughness: 0.85 })
    const turretArmor = new THREE.MeshStandardMaterial({ color: '#7d8a66', roughness: 0.8 })
    const track = new THREE.MeshStandardMaterial({ color: '#3a3f38', roughness: 0.95 })
    const metal = new THREE.MeshStandardMaterial({ color: '#39434a', roughness: 0.45, metalness: 0.55 })
    const trim = new THREE.MeshStandardMaterial({ color: '#c96b3f', roughness: 0.6, metalness: 0.25 })

    const hull = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.7, 3.4), armor)
    hull.position.y = 0.62
    group.add(hull)

    // Track skirts either side, which read as the vehicle's footprint from the chase camera.
    const trackGeometry = new THREE.BoxGeometry(0.42, 0.62, 3.8)
    for (const side of [-1, 1]) {
        const skirt = new THREE.Mesh(trackGeometry, track)
        skirt.position.set(side * 1.16, 0.4, 0)
        group.add(skirt)
    }

    const turret = new THREE.Group()
    turret.name = 'turret'
    turret.position.set(0, 0.97, -0.15)
    // Yaw then pitch: 'YXZ' applies the heading first, so elevation stays in the turret's own frame.
    turret.rotation.order = 'YXZ'
    const dome = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.62, 1.7), turretArmor)
    turret.add(dome)
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 2.6, 10), metal)
    barrel.rotation.x = Math.PI / 2
    barrel.position.set(0, 0.06, -1.9)
    turret.add(barrel)
    const mantlet = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.42, 0.5), trim)
    mantlet.position.set(0, 0.06, -0.95)
    turret.add(mantlet)
    const muzzle = new THREE.Object3D()
    muzzle.name = 'muzzle'
    muzzle.position.set(0, 0.06, -3.2)
    turret.add(muzzle)
    group.add(turret)

    return {
        group,
        turret,
        muzzle,
        dispose() {
            group.traverse((object) => {
                if (object instanceof THREE.Mesh) object.geometry.dispose()
            })
            group.removeFromParent()
            ;[armor, turretArmor, track, metal, trim].forEach((material) => material.dispose())
        },
    }
}
