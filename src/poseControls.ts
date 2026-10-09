import type { Pose } from '@tensorflow-models/pose-detection'
import type { FlightControls } from './flight'

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/**
 * Head orientation read from the face landmarks, in radians. `yaw` and `pitch` are relative to the
 * neutral pose (captured on the first usable frame, or re-centred by `calibrate`); `tilt` is raw roll.
 */
export interface HeadPose {
    yaw: number
    pitch: number
    tilt: number
}

/**
 * Maps the nose-to-eye vertical offset, in ear spans, onto a head pitch. Frontal head pitch is a
 * weak signal — the nose barely moves in the image — so the scale is generous; the weapon's
 * `headAimPitchLimit` trims whatever this over-reads.
 */
const HEAD_PITCH_SCALE = 6
/** Weight of each new head sample, so landmark jitter does not shiver the aim. */
const HEAD_SMOOTHING = 0.25

export interface WingControls extends FlightControls {
    leftWing: number
    rightWing: number
    head: HeadPose | null
}

export class PoseControls {
    private previousHeight: { left: number; right: number } | null = null
    private previousTime: number | null = null
    private neutralSteer = 0
    private smoothedSteer = 0
    private smoothedSpread = 0
    private neutralHead: { yaw: number; pitch: number } | null = null
    private smoothedHeadYaw = 0
    private smoothedHeadPitch = 0

    calibrate(pose: Pose): void {
        const values = this.measure(pose)
        if (values) this.neutralSteer = values.steer
        const head = this.headAngles(pose)
        if (head) this.neutralHead = { yaw: head.yaw, pitch: head.pitch }
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
        const rawHead = this.headAngles(pose)
        // The first usable head sample becomes the neutral pose, so "look straight" aims straight
        // even before the Calibrate button is pressed; `calibrate` re-centres it on demand.
        if (rawHead && this.neutralHead === null) this.neutralHead = { yaw: rawHead.yaw, pitch: rawHead.pitch }
        if (rawHead) {
            const neutral = this.neutralHead ?? { yaw: rawHead.yaw, pitch: rawHead.pitch }
            this.smoothedHeadYaw += (rawHead.yaw - neutral.yaw - this.smoothedHeadYaw) * HEAD_SMOOTHING
            this.smoothedHeadPitch += (rawHead.pitch - neutral.pitch - this.smoothedHeadPitch) * HEAD_SMOOTHING
        }
        const head: HeadPose | null = rawHead
            ? {
                yaw: clamp(this.smoothedHeadYaw, -0.65, 0.65),
                pitch: clamp(this.smoothedHeadPitch, -0.6, 0.6),
                tilt: rawHead.tilt,
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

    /**
     * Reads the head orientation from the face landmarks, or returns null when the face is not
     * visible. Yaw is the nose offset from the ear midpoint (a symmetric measure, so it needs no
     * neutral); pitch is the nose offset from the eye line (which tracks head lift more faithfully
     * than the ears); tilt is the ear-line slope.
     */
    private headAngles(pose: Pose): { yaw: number; pitch: number; tilt: number } | null {
        const find = (name: string) => pose.keypoints.find((point) => point.name === name)
        const nose = find('nose')
        const leftEar = find('left_ear')
        const rightEar = find('right_ear')
        const leftEye = find('left_eye')
        const rightEye = find('right_eye')
        if (!nose || !leftEar || !rightEar) return null
        if (![nose, leftEar, rightEar].every((point) => (point.score ?? 0) >= 0.4)) return null
        const earSpan = Math.abs(rightEar.x - leftEar.x)
        if (earSpan <= 8) return null
        const eyes = leftEye && rightEye && (leftEye.score ?? 0) >= 0.4 && (rightEye.score ?? 0) >= 0.4
            ? (leftEye.y + rightEye.y) / 2
            : (leftEar.y + rightEar.y) / 2
        return {
            yaw: -(nose.x - (leftEar.x + rightEar.x) / 2) / earSpan * 1.5,
            pitch: ((eyes - nose.y) / earSpan) * HEAD_PITCH_SCALE,
            tilt: clamp(-Math.atan((rightEar.y - leftEar.y) / (rightEar.x - leftEar.x)), -0.5, 0.5),
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