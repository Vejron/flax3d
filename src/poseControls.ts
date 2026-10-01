import type { Pose } from '@tensorflow-models/pose-detection'
import type { FlightControls } from './flight'

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

export interface WingControls extends FlightControls {
    leftWing: number
    rightWing: number
    head: { yaw: number; tilt: number } | null
}

export class PoseControls {
    private previousHeight: { left: number; right: number } | null = null
    private previousTime: number | null = null
    private neutralSteer = 0
    private smoothedSteer = 0
    private smoothedSpread = 0

    calibrate(pose: Pose): void {
        const values = this.measure(pose)
        if (values) this.neutralSteer = values.steer
    }

    update(pose: Pose, now: number): WingControls | null {
        const values = this.measure(pose)
        if (!values) {
            this.previousHeight = null
            this.previousTime = null
            return null
        }

        let flapPower = 0
        const dt = this.previousTime === null ? 0 : (now - this.previousTime) / 1000
        if (this.previousHeight && dt > 0 && dt <= 0.5) {
            const leftSpeed = Math.max(0, (values.leftHeight - this.previousHeight.left - 0.015) / dt)
            const rightSpeed = Math.max(0, (values.rightHeight - this.previousHeight.right - 0.015) / dt)
            flapPower = clamp((leftSpeed ** 2 + rightSpeed ** 2) / 2, 0, 3) * Math.max(0.25, values.spread)
        }
        this.previousHeight = { left: values.leftHeight, right: values.rightHeight }
        this.previousTime = now

        const targetSteer = clamp((values.steer - this.neutralSteer) * 1.6, -1, 1)
        this.smoothedSteer += (Math.abs(targetSteer) < 0.12 ? 0 : targetSteer - this.smoothedSteer) * 0.3
        this.smoothedSpread += (values.spread - this.smoothedSpread) * 0.25
        const nose = pose.keypoints.find((point) => point.name === 'nose')
        const leftEar = pose.keypoints.find((point) => point.name === 'left_ear')
        const rightEar = pose.keypoints.find((point) => point.name === 'right_ear')
        const earSpan = leftEar && rightEar ? Math.abs(rightEar.x - leftEar.x) : 0
        const head = nose && leftEar && rightEar && earSpan > 8 &&
            [nose, leftEar, rightEar].every((point) => (point.score ?? 0) >= 0.4)
            ? {
                yaw: clamp(-(nose.x - (leftEar.x + rightEar.x) / 2) / earSpan * 1.5, -0.65, 0.65),
                tilt: clamp(-Math.atan((rightEar.y - leftEar.y) / (rightEar.x - leftEar.x)), -0.5, 0.5),
            }
            : null
        const wingAngle = (start: { x: number; y: number }, end: { x: number; y: number }) =>
            Math.atan2(start.y - end.y, Math.abs(end.x - start.x))
        return {
            flap: false, flapPower, steer: this.smoothedSteer, spread: this.smoothedSpread,
            leftWing: clamp(wingAngle(values.leftShoulder, values.leftWrist), -0.85, 0.85),
            rightWing: clamp(wingAngle(values.rightShoulder, values.rightWrist), -0.85, 0.85),
            head,
        }
    }

    private measure(pose: Pose) {
        const getPoint = (name: string) => pose.keypoints.find((point) => point.name === name)
        const leftShoulder = getPoint('left_shoulder')
        const rightShoulder = getPoint('right_shoulder')
        const leftWrist = getPoint('left_wrist')
        const rightWrist = getPoint('right_wrist')
        const joints = [leftShoulder, rightShoulder, leftWrist, rightWrist]
        if (!leftShoulder || !rightShoulder || !leftWrist || !rightWrist || joints.some((point) => !point || (point.score ?? 0) < 0.4)) return null
        const width = Math.hypot(leftShoulder.x - rightShoulder.x, leftShoulder.y - rightShoulder.y)
        if (width < 10) return null
        const leftHeight = (leftWrist.y - leftShoulder.y) / width
        const rightHeight = (rightWrist.y - rightShoulder.y) / width
        const leftLength = Math.hypot(leftWrist.x - leftShoulder.x, leftWrist.y - leftShoulder.y)
        const rightLength = Math.hypot(rightWrist.x - rightShoulder.x, rightWrist.y - rightShoulder.y)
        const leftArea = leftLength > 0 ? ((leftWrist.x - leftShoulder.x) / leftLength) ** 2 : 0
        const rightArea = rightLength > 0 ? ((rightWrist.x - rightShoulder.x) / rightLength) ** 2 : 0
        const extension = (leftLength + rightLength) / (2 * width)
        return {
            height: (leftHeight + rightHeight) / 2,
            leftHeight,
            rightHeight,
            leftShoulder,
            rightShoulder,
            leftWrist,
            rightWrist,
            steer: (rightHeight - leftHeight) / 2,
            spread: clamp((extension - 0.3) / 0.7, 0, 1) * (leftArea + rightArea) / 2,
        }
    }
}