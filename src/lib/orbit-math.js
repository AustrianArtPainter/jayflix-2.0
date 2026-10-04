const AUTO_SPEED = 0.075;
const DEFAULT_SPEED_PERCENT = 50;
const MIN_SPEED_PERCENT = 0;
const MAX_SPEED_PERCENT = 100;
const INERTIA_STOP_SPEED = 0.0001;
const DRAG_SENSITIVITY = 0.005;
const DAMPING = 1.35;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 5;
const MIN_CARD_SCALE = 0.5;
const MAX_CARD_SCALE = 5;
const MAX_DISPLAY_CARDS = 1322;
const MAX_SPEED = 4.5;
const RELAX_ITERATIONS = 1600;
const RELAX_PAIR_BUDGET = 192000;
const CARD_ASPECT = 1.75;
const FACE_OFFSET_RATIO = 0.003;
const CARD_CLEARANCE = 0.98;
const DRAG_THRESHOLD = 6;
const REAR_OPACITY = 0.24;
const FRONT_OPACITY = 1;
// Hardin–Sloane's 16-point spherical 5-design, not latitude rings:
// https://neilsloane.com/sphdesigns/dim3/des.3.16.5.txt
// The centers preserve direction-balanced moments through degree five.
// Only centers rotate. All complete rectangles stay parallel to the screen.
// Their default 100% size is bounded by the minimum center chord, retaining
// the conservative face-offset envelope. Independently enlarging cards is
// explicitly allowed to overlap; it never repacks centers or grows the radius.
// No random work runs on load, resize or animation; no global optimum claim.
const designT = 1 / Math.sqrt(3);
const designA = 0.9030073291598593, designB = 0.1826964031330545, designC = 0.3888441690006706;
const designPoints = [
    [designT, designT, designT], [designT, -designT, -designT], [-designT, designT, -designT], [-designT, -designT, designT],
    [-designA, -designB, -designC], [-designA, designB, designC], [designA, -designB, designC], [designA, designB, -designC],
    [-designC, -designA, -designB], [designC, -designA, designB], [designC, designA, -designB], [-designC, designA, designB],
    [-designB, -designC, -designA], [designB, designC, -designA], [-designB, designC, designA], [designB, -designC, designA]
];
const PACKED_SLOTS = Object.freeze(designPoints.map(([x, y, z]) => Object.freeze({
    latitude: -Math.asin(y), longitude: Math.atan2(x, z)
})));
const slotCache = new Map();
const separationCache = new WeakMap();
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function createSlots(count) {
    count = Number.isFinite(Number(count)) ? Math.max(0, Math.floor(Number(count))) : 0;
    if (count === 16) return PACKED_SLOTS;
    if (slotCache.has(count)) return slotCache.get(count);
    // Use the actual displayed count, without padding or duplicate cards.
    // Keep this pure geometry function uncapped for capacity calculations;
    // the homepage enforces its DOM limit before requesting these slots.
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    let points = Array.from({ length: count }, (_, index) => {
        const y = 1 - 2 * (index + 0.5) / count;
        const ring = Math.sqrt(Math.max(0, 1 - y * y));
        return [ring * Math.sin(index * goldenAngle), y, ring * Math.cos(index * goldenAngle)];
    });
    let best = points, bestDistance = 0;
    const pairs = count * (count - 1) / 2;
    const iterations = pairs ? Math.min(RELAX_ITERATIONS, Math.floor(RELAX_PAIR_BUDGET / pairs)) : 0;
    // Minimise a steep repulsion energy on the unit sphere with a fixed work budget.
    // Keep the best minimum spacing encountered; resize/rotation never reruns this.
    // With zero iterations the old pass only measured/allocated forces;
    // it never moved the Fibonacci seed. Skip that quadratic no-op.
    for (let pass = 0; iterations && pass <= iterations && pairs; pass++) {
        const forces = points.map(() => [0, 0, 0]);
        let minimum = Infinity;
        for (let first = 0; first < count; first++) {
            for (let second = first + 1; second < count; second++) {
                const delta = points[first].map((value, axis) => value - points[second][axis]);
                const distance = Math.hypot(...delta);
                minimum = Math.min(minimum, distance);
                const weight = Math.max(0.1, distance) ** -10;
                for (let axis = 0; axis < 3; axis++) {
                    forces[first][axis] += delta[axis] * weight;
                    forces[second][axis] -= delta[axis] * weight;
                }
            }
        }
        if (minimum > bestDistance) {
            bestDistance = minimum;
            best = points;
        }
        if (pass === iterations) break;
        const step = 0.004 * (1 - pass / (iterations + 200));
        points = points.map((point, index) => {
            const radial = forces[index].reduce((sum, value, axis) => sum + value * point[axis], 0);
            const tangent = forces[index].map((value, axis) => value - radial * point[axis]);
            const limit = Math.min(1, 0.03 / (Math.hypot(...tangent) * step || 1));
            const next = point.map((value, axis) => value + tangent[axis] * step * limit);
            const length = Math.hypot(...next);
            return next.map(value => value / length);
        });
    }
    const slots = Object.freeze(best.map(point => Object.freeze({
        latitude: Math.asin(clamp(-point[1], -1, 1)),
        longitude: Math.atan2(point[0], point[2])
    })));
    if (slotCache.size >= 8) slotCache.delete(slotCache.keys().next().value);
    slotCache.set(count, slots);
    return slots;
}

function minimumSeparation(slots) {
    if (separationCache.has(slots)) return separationCache.get(slots);
    const normals = slots.map(slot => positionOnSphere(slot, 1));
    let minimum = Math.PI;
    if (normals.length <= 512) {
        for (let first = 0; first < normals.length; first++) {
            for (let second = first + 1; second < normals.length; second++) {
                const a = normals[first], b = normals[second];
                minimum = Math.min(minimum, Math.acos(clamp(a.x * b.x + a.y * b.y + a.z * b.z, -1, 1)));
            }
        }
    } else {
        // Exact nearest pair, not approximate sampling: an initial pair
        // bounds the answer. Every closer pair lies in one of 27 adjacent
        // cubes of that side length. Positions themselves are unchanged.
        const squared = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
        let best = squared(normals[0], normals[3]);
        if (best === 0) return 0;
        const cell = Math.sqrt(best), side = Math.ceil(2 / cell) + 4;
        const numeric = Number.isSafeInteger(side ** 3);
        const key = numeric ? (x, y, z) => x + side * (y + side * z)
            : (x, y, z) => `${x},${y},${z}`;
        const buckets = new Map();
        for (const point of normals) {
            const x = Math.floor((point.x + 1) / cell) + 1;
            const y = Math.floor((point.y + 1) / cell) + 1;
            const z = Math.floor((point.z + 1) / cell) + 1;
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
                const neighbors = buckets.get(key(x + dx, y + dy, z + dz));
                if (neighbors) for (const other of neighbors) best = Math.min(best, squared(point, other));
            }
            const ownKey = key(x, y, z), bucket = buckets.get(ownKey);
            if (bucket) bucket.push(point); else buckets.set(ownKey, [point]);
        }
        minimum = 2 * Math.asin(Math.min(1, Math.sqrt(best) / 2));
    }
    if (Object.isFrozen(slots) && slots.every(Object.isFrozen)) separationCache.set(slots, minimum);
    return minimum;
}

function computeLayout(width, height, slots) {
    const radius = Math.max(0, Math.min(width * 0.34, height * 0.35, 245));
    const faceOffset = radius * FACE_OFFSET_RATIO;
    const minimumAngle = minimumSeparation(slots);
    const minimumChord = 2 * radius * Math.sin(minimumAngle / 2);
    // Retain the conservative W x 1.75W x 2t camera-space envelope, even
    // though only its original +t content face now needs to be rendered.
    // Its Minkowski difference has diagonal sqrt(W² + H² + (2t)²).
    // A smaller diagonal than every center chord excludes intersections for
    // ALL rotations of the centers while the cards stay camera-aligned.
    // Without clearance this is the chosen envelope's size boundary, not
    // an exact planar-card or global point-layout optimality certificate.
    const cardWidth = Math.sqrt(Math.max(0,
        (minimumChord * CARD_CLEARANCE) ** 2 - (2 * faceOffset) ** 2)) / Math.hypot(1, CARD_ASPECT);
    return {
        radius, faceOffset, minimumAngle, minimumChord, cardWidth,
        cardHeight: cardWidth * CARD_ASPECT,
        footerHeight: cardWidth * 0.25,
        perspective: radius * 5.5
    };
}

function positionOnSphere(slot, radius) {
    const ringRadius = radius * Math.cos(slot.latitude);
    return {
        x: ringRadius * Math.sin(slot.longitude),
        y: -radius * Math.sin(slot.latitude),
        z: ringRadius * Math.cos(slot.longitude),
        yaw: slot.longitude * 180 / Math.PI,
        pitch: slot.latitude * 180 / Math.PI
    };
}

function cardDimensionsFromScale(layout, scale = 1) {
    const cardScale = clamp(Number.isFinite(scale) ? scale : 1, MIN_CARD_SCALE, MAX_CARD_SCALE);
    return {
        cardScale,
        cardWidth: layout.cardWidth * cardScale,
        cardHeight: layout.cardHeight * cardScale,
        footerHeight: layout.footerHeight * cardScale
    };
}

// Diagnostic only: keep the original 16-card reference dimensions instead
// of silently making each rectangle smaller when the point count grows.
function computeReferenceLayout(width, height, slots) {
    const layout = computeLayout(width, height, slots);
    const reference = computeLayout(width, height, PACKED_SLOTS);
    return { ...layout, cardWidth: reference.cardWidth,
        cardHeight: reference.cardHeight, footerHeight: reference.footerHeight };
}

function advanceRotation(angle, velocity, targetVelocity, elapsed) {
    elapsed = Math.max(0, elapsed);
    const decay = Math.exp(-DAMPING * elapsed);
    // Exact integration of dv/dt = -DAMPING * (v - targetVelocity).
    return {
        angle: angle + targetVelocity * elapsed + (velocity - targetVelocity) * (1 - decay) / DAMPING,
        velocity: targetVelocity + (velocity - targetVelocity) * decay
    };
}

function velocityFromDrag(distance, elapsed) {
    return clamp(distance * DRAG_SENSITIVITY / Math.max(0.008, elapsed), -MAX_SPEED, MAX_SPEED);
}

function normalizeQuaternion(quaternion) {
    const length = Math.hypot(...quaternion);
    return length > 1e-12 && Number.isFinite(length) ? quaternion.map(value => value / length) : [1, 0, 0, 0];
}

function rotateOrientation(orientation, vector) {
    const angle = Math.hypot(...vector);
    if (angle < 1e-12) return normalizeQuaternion(orientation);
    const factor = Math.sin(angle / 2) / angle;
    const [a, b, c, d] = [Math.cos(angle / 2), ...vector.map(value => value * factor)];
    const [w, x, y, z] = orientation;
    // Left multiply: both screen-space drag components contribute together,
    // even after crossing the old poles. There is no axis lock or pitch clamp.
    return normalizeQuaternion([
        a * w - b * x - c * y - d * z,
        a * x + b * w + c * z - d * y,
        a * y - b * z + c * w + d * x,
        a * z + b * y - c * x + d * w
    ]);
}

function orientationMatrix(orientation) {
    const [w, x, y, z] = normalizeQuaternion(orientation);
    // CSS matrix3d is column-major, with no per-card depth/z-index override.
    return [
        1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y), 0,
        2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x), 0,
        2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y), 0,
        0, 0, 0, 1
    ];
}

function inverseOrientationMatrix(orientation) {
    const [w, x, y, z] = normalizeQuaternion(orientation);
    return orientationMatrix([w, -x, -y, -z]);
}

function gestureVector(horizontal, vertical) {
    return [vertical ? -vertical * DRAG_SENSITIVITY : 0, horizontal * DRAG_SENSITIVITY, 0];
}

function velocityFromGesture(horizontal, vertical, elapsed) {
    const vector = gestureVector(horizontal, vertical).map(value => value / Math.max(0.008, elapsed));
    const limit = Math.min(1, MAX_SPEED / (Math.hypot(...vector) || 1));
    return vector.map(value => value * limit);
}

function advanceOrientation(orientation, velocity, targetVelocity, elapsed) {
    elapsed = clamp(Number.isFinite(elapsed) ? elapsed : 0, 0, 1);
    // Keep every component of the release velocity. Its slow continuation
    // follows that same direction, so exponential damping does not snap axes.
    const components = velocity.map((value, axis) => advanceRotation(0, value, targetVelocity[axis], elapsed));
    const rotation = components.map(next => next.angle), speed = components.map(next => next.velocity);
    return { orientation: rotateOrientation(orientation, rotation), velocity: speed };
}

function autoSpeedFromPercent(percent) {
    const value = clamp(Number.isFinite(percent) ? percent : DEFAULT_SPEED_PERCENT, MIN_SPEED_PERCENT, MAX_SPEED_PERCENT);
    return AUTO_SPEED * value / DEFAULT_SPEED_PERCENT;
}

function zoomFromPinch(initialZoom, initialDistance, currentDistance) {
    if (initialDistance <= 0) return clamp(initialZoom, MIN_ZOOM, MAX_ZOOM);
    return clamp(initialZoom * currentDistance / initialDistance, MIN_ZOOM, MAX_ZOOM);
}

function opacityFromDepth(depth, radius) {
    // Spatial interpolation, not a time-based transition: opacity must match
    // the current position even while dragging quickly or reversing direction.
    const fraction = Number.isFinite(depth) && Number.isFinite(radius) && radius > 0
        ? clamp((depth / radius + 1) / 2, 0, 1) : 0.5;
    return REAR_OPACITY + (FRONT_OPACITY - REAR_OPACITY) * fraction;
}


export const OrbitMath = Object.freeze({AUTO_SPEED, DEFAULT_SPEED_PERCENT, MIN_SPEED_PERCENT, MAX_SPEED_PERCENT, INERTIA_STOP_SPEED, MIN_ZOOM, MAX_ZOOM, MIN_CARD_SCALE, MAX_CARD_SCALE, MAX_DISPLAY_CARDS, DAMPING, DRAG_SENSITIVITY, RELAX_ITERATIONS, CARD_ASPECT, DRAG_THRESHOLD, FACE_OFFSET_RATIO, CARD_CLEARANCE, REAR_OPACITY, FRONT_OPACITY, createSlots, minimumSeparation, computeLayout, computeReferenceLayout, positionOnSphere, cardDimensionsFromScale, advanceRotation, velocityFromDrag, autoSpeedFromPercent, zoomFromPinch, opacityFromDepth, normalizeQuaternion, rotateOrientation, orientationMatrix, inverseOrientationMatrix, gestureVector, velocityFromGesture, advanceOrientation});
export { AUTO_SPEED, DEFAULT_SPEED_PERCENT, MIN_SPEED_PERCENT, MAX_SPEED_PERCENT, INERTIA_STOP_SPEED, MIN_ZOOM, MAX_ZOOM, MIN_CARD_SCALE, MAX_CARD_SCALE, MAX_DISPLAY_CARDS, DAMPING, DRAG_SENSITIVITY, RELAX_ITERATIONS, CARD_ASPECT, DRAG_THRESHOLD, FACE_OFFSET_RATIO, CARD_CLEARANCE, REAR_OPACITY, FRONT_OPACITY, createSlots, minimumSeparation, computeLayout, computeReferenceLayout, positionOnSphere, cardDimensionsFromScale, advanceRotation, velocityFromDrag, autoSpeedFromPercent, zoomFromPinch, opacityFromDepth, normalizeQuaternion, rotateOrientation, orientationMatrix, inverseOrientationMatrix, gestureVector, velocityFromGesture, advanceOrientation };
