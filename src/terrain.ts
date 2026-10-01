export function terrainHeight(x: number, z: number): number {
    const rolling = (Math.cos((z + 80) * 0.018) - Math.cos(80 * 0.018)) * Math.cos(x * 0.012) * 15
    const crossing = Math.sin(x * 0.014) * Math.cos(z * 0.012) * 11
    const detail = Math.sin(z * 0.041 + x * 0.013) * 2.3
    const distance = Math.min(1, Math.hypot(x, z) / 40)
    return (rolling + crossing + detail) * (0.15 + 0.85 * distance * distance)
}