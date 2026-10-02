import * as THREE from 'three'
import { courseRings, courseSpawn } from './course'
import type { FlightControls, FlightState } from './flight'
import type { RemoteFlight } from './network'
import { terrainHeight } from './terrain'

export { terrainHeight } from './terrain'

export function createScene(container: HTMLElement) {
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#d3e8df')
    scene.fog = new THREE.FogExp2('#d3e8df', 0.004)
    const camera = new THREE.PerspectiveCamera(68, 1, 0.1, 1300)
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.6
    container.appendChild(renderer.domElement)

    scene.add(new THREE.HemisphereLight('#fff8dd', '#577d6d', 2.3))
    const sun = new THREE.DirectionalLight('#fff2cf', 2.8)
    sun.position.set(-60, 90, -80)
    scene.add(sun)

    const earth = new THREE.PlaneGeometry(900, 900, 100, 100)
    earth.rotateX(-Math.PI / 2)
    const position = earth.getAttribute('position')
    if (!position) throw new Error('Terrain geometry has no position attribute')
    for (let index = 0; index < position.count; index++) {
        position.setY(index, terrainHeight(position.getX(index), position.getZ(index)))
    }
    earth.computeVertexNormals()
    const lowland = new THREE.Color('#698967')
    const hillside = new THREE.Color('#a2b780')
    const crest = new THREE.Color('#d3c9a4')
    const groundColor = new THREE.Color()
    const colors: number[] = []
    for (let index = 0; index < position.count; index++) {
        const height = position.getY(index)
        groundColor.copy(lowland).lerp(hillside, THREE.MathUtils.clamp((height + 8) / 23, 0, 1))
        groundColor.lerp(crest, THREE.MathUtils.clamp((height - 9) / 18, 0, 0.7))
        colors.push(groundColor.r, groundColor.g, groundColor.b)
    }
    earth.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    const land = new THREE.Mesh(earth, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }))
    scene.add(land)

    const trunkGeometry = new THREE.CylinderGeometry(0.16, 0.23, 1.6, 5)
    const crownGeometry = new THREE.ConeGeometry(1.4, 4.4, 6)
    const trunkMaterial = new THREE.MeshStandardMaterial({ color: '#785c47', flatShading: true })
    const crownMaterials = ['#406b55', '#527c5a', '#627a48'].map((color) => new THREE.MeshStandardMaterial({ color, flatShading: true }))
    for (let index = 0; index < 125; index++) {
        const x = Math.sin(index * 53.47) * 350
        const z = Math.cos(index * 29.61) * 350
        if (Math.hypot(x, z) < 22) continue
        const scale = 0.8 + (index % 6) * 0.12
        const tree = new THREE.Group()
        const trunk = new THREE.Mesh(trunkGeometry, trunkMaterial)
        trunk.position.y = 0.8
        const crown = new THREE.Mesh(crownGeometry, crownMaterials[index % crownMaterials.length]!)
        crown.position.y = 3.15
        tree.add(trunk, crown)
        tree.position.set(x, terrainHeight(x, z), z)
        tree.scale.setScalar(scale)
        scene.add(tree)
    }

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
    const wings: { shoulder: THREE.Group; elbow: THREE.Group; side: number }[] = []
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
    scene.add(flyer)
    const remoteFlyers = new Map<number, THREE.Group>()
    const remoteBadgeGeometry = new THREE.SphereGeometry(0.18, 8, 6)
    const remoteBadgeMaterial = new THREE.MeshBasicMaterial({ color: '#45dbbb' })

    const courseMarkers = courseRings.map((ring) => {
        const color = ring.kind === 'start' ? '#45dbbb' : ring.kind === 'finish' ? '#ffd07e' : '#e4f5ee'
        const material = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.4, roughness: 0.3 })
        const marker = new THREE.Group()
        marker.position.set(ring.x, ring.y, ring.z)
        marker.rotation.y = Math.atan2(-ring.forwardX, -ring.forwardZ)
        marker.add(new THREE.Mesh(new THREE.TorusGeometry(ring.radius, 0.18, 10, 64), material))
        if (ring.kind !== 'checkpoint') {
            marker.add(new THREE.Mesh(new THREE.TorusGeometry(ring.radius + 0.35, 0.07, 8, 64), material))
        }
        const beacon = new THREE.Mesh(new THREE.OctahedronGeometry(0.32), material)
        beacon.position.y = ring.radius + 0.75
        marker.add(beacon)
        scene.add(marker)
        return material
    })

    const trailSamples = 64
    const trailMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
    const trails = wings.map(({ elbow, side }) => {
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(trailSamples * 6), 3).setUsage(THREE.DynamicDrawUsage))
        geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(trailSamples * 8), 4).setUsage(THREE.DynamicDrawUsage))
        const indices: number[] = []
        for (let index = 0; index < trailSamples - 1; index++) {
            const vertex = index * 2
            indices.push(vertex, vertex + 1, vertex + 2, vertex + 1, vertex + 3, vertex + 2)
        }
        geometry.setIndex(indices)
        geometry.setDrawRange(0, 0)
        const ribbon = new THREE.Mesh(geometry, trailMaterial)
        ribbon.frustumCulled = false
        ribbon.renderOrder = 1
        scene.add(ribbon)
        return { elbow, side, geometry, points: [] as THREE.Vector3[] }
    })
    const trailDirection = new THREE.Vector3()
    const trailView = new THREE.Vector3()
    const trailSide = new THREE.Vector3()

    const cameraTarget = new THREE.Vector3(
        courseSpawn.x - Math.sin(courseSpawn.yaw) * 12,
        terrainHeight(courseSpawn.x, courseSpawn.z) + 7,
        courseSpawn.z + Math.cos(courseSpawn.yaw) * 12,
    )
    camera.position.copy(cameraTarget)
    let cameraYaw = courseSpawn.yaw
    let lastCameraTime = 0
    function resize() {
        const width = container.clientWidth
        const height = container.clientHeight
        if (!width || !height) return
        camera.aspect = width / height
        camera.updateProjectionMatrix()
        renderer.setSize(width, height)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    resize()

    let lastFlapAt = -Infinity
    function render(state: FlightState, elapsed: number, input: FlightControls, poseWings: { leftWing: number; rightWing: number } | null, poseHead: { yaw: number; tilt: number } | null, nextRing: number, remotes: RemoteFlight[] = []) {
        const active = new Set(remotes.map((remote) => remote.id))
        for (const [id, avatar] of remoteFlyers) {
            if (!active.has(id)) { scene.remove(avatar); remoteFlyers.delete(id) }
        }
        for (const remote of remotes) {
            let avatar = remoteFlyers.get(remote.id)
            if (!avatar) {
                avatar = flyer.clone(true)
                const badge = new THREE.Mesh(remoteBadgeGeometry, remoteBadgeMaterial)
                badge.position.y = 2.35
                avatar.add(badge)
                scene.add(avatar)
                remoteFlyers.set(remote.id, avatar)
            }
            avatar.position.set(remote.flight.x, remote.flight.y + 1.1, remote.flight.z)
            avatar.rotation.set(0, -remote.flight.yaw, remote.flight.bank)
            const wingAngle = Math.sin(elapsed * 12) * (remote.flap ? 0.55 : 0.07) - (1 - remote.spread) * 0.85
            for (let index = 0; index < 2; index++) {
                avatar.children[index + 2]!.rotation.z = (index === 0 ? -1 : 1) * wingAngle
            }
        }
        courseMarkers.forEach((material, index) => { material.emissiveIntensity = index === nextRing ? 1.8 : 0.4 })
        if (input.flap) lastFlapAt = elapsed
        const beat = Math.sin(Math.min(1, (elapsed - lastFlapAt) / 0.45) * Math.PI * 2) * 0.62
        for (const { shoulder, elbow, side } of wings) {
            const angle = poseWings ? (side < 0 ? poseWings.leftWing : poseWings.rightWing) : beat - (1 - input.spread) * 0.85
            const lag = angle - shoulder.rotation.z * side
            const tip = THREE.MathUtils.clamp(-0.1 + angle * 0.3 - lag * 0.65, -0.65, 0.65)
            shoulder.rotation.z += (side * angle - shoulder.rotation.z) * 0.25
            elbow.rotation.z += (side * tip - elbow.rotation.z) * 0.16
        }
        head.rotation.y += ((poseHead?.yaw ?? 0) - head.rotation.y) * 0.18
        head.rotation.z += ((poseHead?.tilt ?? 0) - head.rotation.z) * 0.18
        flyer.position.set(state.x, state.y + 1.1, state.z)
        flyer.rotation.set(Math.sin(elapsed * 2) * 0.025, -state.yaw, state.bank)
        const dt = Math.min(elapsed - lastCameraTime, 0.05)
        lastCameraTime = elapsed
        const angle = Math.atan2(Math.sin(state.yaw - cameraYaw), Math.cos(state.yaw - cameraYaw))
        cameraYaw += angle * (1 - Math.exp(-2.3 * dt))
        cameraTarget.set(state.x - Math.sin(cameraYaw) * 12, state.y + 7, state.z + Math.cos(cameraYaw) * 12)
        camera.position.lerp(cameraTarget, 1 - Math.exp(-3 * dt))
        camera.lookAt(state.x + Math.sin(cameraYaw) * 7, state.y + 1, state.z - Math.cos(cameraYaw) * 7)
        flyer.updateMatrixWorld(true)
        for (const trail of trails) {
            if (!state.flying || state.speed < 4) {
                trail.points.length = 0
                trail.geometry.setDrawRange(0, 0)
                continue
            }
            const tip = trail.elbow.localToWorld(new THREE.Vector3(trail.side * 1.65, 0, 0.3))
            if (!trail.points.length || trail.points[0]!.distanceToSquared(tip) > 0.02) trail.points.unshift(tip)
            if (trail.points.length > trailSamples) trail.points.length = trailSamples
            const length = Math.min(12, (state.speed - 3) * 0.6)
            const positions = trail.geometry.getAttribute('position') as THREE.BufferAttribute
            const colors = trail.geometry.getAttribute('color') as THREE.BufferAttribute
            let distance = 0
            let count = 0
            for (let index = 0; index < trail.points.length; index++) {
                const point = trail.points[index]!
                if (index) distance += point.distanceTo(trail.points[index - 1]!)
                if (distance > length) break
                const progress = distance / length
                const neighbor = trail.points[Math.min(index + 1, trail.points.length - 1)]!
                trailDirection.subVectors(point, neighbor).normalize()
                trailView.subVectors(camera.position, point).normalize()
                trailSide.crossVectors(trailDirection, trailView).normalize().multiplyScalar(0.04 + 0.065 * (1 - progress))
                positions.setXYZ(index * 2, point.x + trailSide.x, point.y + trailSide.y, point.z + trailSide.z)
                positions.setXYZ(index * 2 + 1, point.x - trailSide.x, point.y - trailSide.y, point.z - trailSide.z)
                const opacity = 0.72 * (1 - progress) ** 1.7
                colors.setXYZW(index * 2, 0.86, 0.97, 1, opacity)
                colors.setXYZW(index * 2 + 1, 0.86, 0.97, 1, opacity)
                count++
            }
            positions.needsUpdate = true
            colors.needsUpdate = true
            trail.geometry.setDrawRange(0, Math.max(0, count - 1) * 6)
        }
        renderer.render(scene, camera)
    }

    function dispose() {
        observer.disconnect()
        remoteBadgeGeometry.dispose()
        remoteBadgeMaterial.dispose()
        scene.traverse((object) => {
            if (object instanceof THREE.Mesh) object.geometry.dispose()
        })
            ;[bodyMaterial, wingMaterial, featherMaterial, beakMaterial, eyeMaterial, trunkMaterial, trailMaterial, ...courseMarkers, ...crownMaterials, land.material].forEach((material) => material.dispose())
        renderer.dispose()
        renderer.domElement.remove()
    }

    return { render, dispose }
}