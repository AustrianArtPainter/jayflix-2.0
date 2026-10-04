import { OrbitMath, clamp } from './orbit-math.js';
const { AUTO_SPEED, DEFAULT_SPEED_PERCENT, MIN_SPEED_PERCENT, MAX_SPEED_PERCENT, INERTIA_STOP_SPEED, MIN_ZOOM, MAX_ZOOM, MIN_CARD_SCALE, MAX_CARD_SCALE, MAX_DISPLAY_CARDS, DRAG_THRESHOLD, createSlots, computeLayout, computeReferenceLayout, positionOnSphere, cardDimensionsFromScale, autoSpeedFromPercent, zoomFromPinch, opacityFromDepth, rotateOrientation, orientationMatrix, gestureVector, velocityFromGesture, advanceOrientation } = OrbitMath;

/** Scoped imperative animation: React owns markup, this controller owns styles and events. */
export function createOrbitController(root, global = window) {
        const document = global.document;
        let destroyed = false;
        const listeners = [];
        function listen(target, type, callback, options) {
            if (!target) return;
            target.addEventListener(type, callback, options);
            listeners.push(() => target.removeEventListener(type, callback, options));
        }
        const scene = root.querySelector('#recommendationOrbit');
        const container = root.querySelector('#douban-results');
        if (!scene || !container || scene.dataset.orbitReady) return;
        // These opt-in attributes exist only on orbit-test.html. Normal home
        // cards, default sizing and whole-container zoom remain unchanged.
        const capacityTest = scene.dataset.orbitTest === 'capacity-reference';
        const referenceTest = capacityTest || scene.dataset.orbitTest === '212-reference';
        const placeholderTest = referenceTest || scene.dataset.orbitTest === '212-current';
        scene.dataset.orbitReady = 'true';
        container.classList.add('orbit-sphere');

        const wireframe = scene.querySelector('.orbit-wireframe');
        const camera = scene.querySelector('.orbit-camera');
        const loading = scene.querySelector('.orbit-loading');
        const counter = root.querySelector('#orbitCount');
        const zoomButton = root.querySelector('#orbitZoom');
        const cardSizeButton = root.querySelector('#orbitCardScale');
        const speedDisplay = root.querySelector('#orbitSpeed');
        const pauseButton = root.querySelector('#orbitPause');
        const controls = root.querySelector('.orbit-control-stack');
        const reduceMotion = global.matchMedia('(prefers-reduced-motion: reduce)');
        // Responsive homepage defaults; fixed diagnostic presets remain independent.
        const mobileLayout = placeholderTest ? null : global.matchMedia('(max-width: 600px)');
        const resetButton = root.querySelector('#orbitReset');
        function homeDefaults() {
            return mobileLayout?.matches ? { zoom: 1.5, cardScale: 1.5 } : { zoom: 2, cardScale: 0.7 };
        }
        const pointers = new Map();
        const state = {
            orientation: rotateOrientation([1, 0, 0, 0], [0, -0.2, 0]),
            velocity: [0, AUTO_SPEED, 0], autoVelocity: [0, AUTO_SPEED, 0],
            autoDirection: [0, 1, 0], speedPercent: DEFAULT_SPEED_PERCENT,
            zoom: 1, cardScale: 1, cardLayout: null, paused: capacityTest || reduceMotion.matches, dragging: false,
            pinching: false, visible: true, focused: false,
            cards: [], faces: [], positions: [], radius: 0, pinchDistance: 0, pinchZoom: 1,
            suppressClickUntil: 0, frame: 0, previousTime: 0, dirty: false
        };

        // Homepage preferences are separate from history and diagnostic presets.
        // Never store orientation/inertia or touch storage from the render loop.
        const preferencesKey = 'jayflix.orbit.preferences.v1';
        let preferencesReady = false, preferencesDirty = false, preferencesTimer = 0;
        let lastSavedPreferences = '';
        function readPreferences() {
            if (placeholderTest) return {};
            try {
                const saved = JSON.parse(global.localStorage.getItem(preferencesKey));
                if (!saved || saved.version !== 1 || Array.isArray(saved)) return {};
                const valid = {};
                for (const [name, min, max] of [
                    ['zoom', MIN_ZOOM, MAX_ZOOM], ['cardScale', MIN_CARD_SCALE, MAX_CARD_SCALE],
                    ['speedPercent', MIN_SPEED_PERCENT, MAX_SPEED_PERCENT]
                ]) {
                    if (Number.isFinite(saved[name]) && saved[name] >= min && saved[name] <= max) valid[name] = saved[name];
                }
                if (typeof saved.paused === 'boolean') valid.paused = saved.paused;
                return valid;
            } catch { return {}; } // Blocked storage or damaged JSON must not break the UI.
        }

        function savePreferences() {
            if (preferencesTimer) global.clearTimeout(preferencesTimer);
            preferencesTimer = 0;
            if (!preferencesReady || placeholderTest || !preferencesDirty) return;
            preferencesDirty = false;
            const value = JSON.stringify({ version: 1, zoom: state.zoom, cardScale: state.cardScale,
                speedPercent: state.speedPercent, paused: state.paused });
            if (value === lastSavedPreferences) return;
            try {
                global.localStorage.setItem(preferencesKey, value);
                lastSavedPreferences = value;
            } catch { /* Keep controls usable if storage is unavailable/full. */ }
        }

        function queuePreferencesSave() {
            if (!preferencesReady || placeholderTest) return;
            preferencesDirty = true;
            if (preferencesTimer) global.clearTimeout(preferencesTimer);
            // Coalesce high-frequency wheel/pinch input, then flush at gesture
            // end or page exit so an immediate refresh retains the final value.
            preferencesTimer = global.setTimeout(savePreferences, 150);
        }

        function paint() {
            const orientation = state.cards.length ? state.orientation : [1, 0, 0, 0];
            const matrix = orientationMatrix(orientation);
            const centerScale = referenceTest ? state.zoom : 1;
            if (wireframe) wireframe.style.transform = `matrix3d(${matrix.join(',')})`;
            state.cards.forEach((card, index) => {
                const point = state.positions[index];
                if (!point) return;
                // Q * T(p) * inverse(Q) = T(Qp). Flatten that identity here:
                // animate direct transforms, not inherited matrix CSS variables
                // that needlessly invalidate every poster/text descendant.
                const x = (matrix[0] * point.x + matrix[4] * point.y + matrix[8] * point.z) * centerScale;
                const y = (matrix[1] * point.x + matrix[5] * point.y + matrix[9] * point.z) * centerScale;
                const depth = (matrix[2] * point.x + matrix[6] * point.y + matrix[10] * point.z) * centerScale;
                card.style.transform = `translate3d(${x}px, ${y}px, ${depth}px)`;
                // Opacity belongs on the FLAT content face, never the preserve-3d
                // carrier. One real upright face stays interactive at every depth.
                state.faces[index].style.opacity = String(opacityFromDepth(depth, state.radius * centerScale));
            });
            state.dirty = false;
        }

        function canAutoRotate() {
            return !state.dragging && !state.pinching && !state.paused && !state.focused &&
                (state.speedPercent > 0 || Math.hypot(...state.velocity) > INERTIA_STOP_SPEED);
        }

        function schedule() {
            if (!destroyed && !state.frame && state.visible && !document.hidden && state.cards.length && (state.dirty || canAutoRotate())) {
                state.frame = global.requestAnimationFrame(animate);
            }
        }

        function requestPaint() {
            state.dirty = true;
            schedule();
        }

        function animate(time) {
            state.frame = 0;
            if (!state.visible || document.hidden) {
                state.previousTime = 0;
                return;
            }
            // Honor short stalls so inertia decays by wall time, rather than
            // stretching a slow frame into many extra high-speed frames.
            const elapsed = state.previousTime ? clamp((time - state.previousTime) / 1000, 0, 0.25) : 0;
            state.previousTime = time;
            if (canAutoRotate() && elapsed > 0) {
                const next = advanceOrientation(state.orientation, state.velocity, state.autoVelocity, elapsed);
                state.orientation = next.orientation;
                state.velocity = next.velocity;
                // Zero disables the slow continuation, not release inertia. Once
                // its tail is imperceptible, stop instead of running rAF forever.
                if (state.speedPercent === 0 && Math.hypot(...state.velocity) <= INERTIA_STOP_SPEED) state.velocity = [0, 0, 0];
                state.dirty = true;
            }
            if (state.dirty) paint();
            schedule();
        }

        function updateControls() {
            zoomButton.textContent = `${Math.round(state.zoom * 100)}%`;
            zoomButton.setAttribute('aria-label', `当前球体缩放 ${Math.round(state.zoom * 100)}%${placeholderTest ? '，点击重置至100%' : ''}`);
            cardSizeButton.textContent = `${Math.round(state.cardScale * 100)}%`;
            cardSizeButton.setAttribute('aria-label', `当前封面尺寸 ${Math.round(state.cardScale * 100)}%${placeholderTest ? '，点击重置至100%' : ''}`);
            if (speedDisplay) {
                speedDisplay.textContent = `${Math.round(state.speedPercent)}%`;
                speedDisplay.setAttribute('aria-label', `当前自动旋转转速 ${Math.round(state.speedPercent)}%，50%为默认转速`);
                controls.querySelector('[data-orbit-action="speed-out"]').disabled = state.speedPercent <= MIN_SPEED_PERCENT;
                controls.querySelector('[data-orbit-action="speed-in"]').disabled = state.speedPercent >= MAX_SPEED_PERCENT;
            }
            if (resetButton) {
                const defaults = homeDefaults();
                const label = `重置球体至${Math.round(defaults.zoom * 100)}%、封面至${Math.round(defaults.cardScale * 100)}%、转速至${DEFAULT_SPEED_PERCENT}%`;
                resetButton.setAttribute('aria-label', label);
                resetButton.setAttribute('title', label);
            }
            pauseButton.setAttribute('aria-pressed', String(state.paused));
            pauseButton.setAttribute('aria-label', state.paused ? '恢复自动旋转' : '暂停自动旋转');
            pauseButton.querySelector('.orbit-pause-label').textContent = state.paused ? '继续' : '暂停';
            controls.querySelector('[data-orbit-action="zoom-out"]').disabled = state.zoom <= MIN_ZOOM + 0.001;
            controls.querySelector('[data-orbit-action="zoom-in"]').disabled = state.zoom >= MAX_ZOOM - 0.001;
            controls.querySelector('[data-orbit-action="card-size-out"]').disabled = state.cardScale <= MIN_CARD_SCALE + 0.001;
            controls.querySelector('[data-orbit-action="card-size-in"]').disabled = state.cardScale >= MAX_CARD_SCALE - 0.001;
        }

        function setAutoSpeed(percent) {
            const followingAuto = !state.dragging && !state.pinching &&
                Math.hypot(...state.velocity.map((value, axis) => value - state.autoVelocity[axis])) <= INERTIA_STOP_SPEED;
            state.speedPercent = clamp(Number.isFinite(percent) ? percent : DEFAULT_SPEED_PERCENT, MIN_SPEED_PERCENT, MAX_SPEED_PERCENT);
            state.autoVelocity = state.autoDirection.map(value => value * autoSpeedFromPercent(state.speedPercent));
            // Apply a steady-speed adjustment immediately without throwing away
            // a faster, still-decaying gesture or changing its direction.
            if (followingAuto) state.velocity = state.autoVelocity.slice();
            state.previousTime = 0;
            scene.dataset.speedPercent = String(state.speedPercent);
            updateControls();
            schedule();
            queuePreferencesSave();
        }

        function setZoom(zoom) {
            state.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
            applySceneScale();
            scene.dataset.zoom = String(state.zoom);
            updateControls();
            if (referenceTest) requestPaint();
            queuePreferencesSave();
        }

        function applySceneScale(updateDimensions = false) {
            camera.style.transform = referenceTest ? 'scale3d(1, 1, 1)'
                : `scale3d(${state.zoom}, ${state.zoom}, ${state.zoom})`;
            if (!state.cardLayout || (!referenceTest && !updateDimensions)) return;
            const centerScale = referenceTest ? state.zoom : 1;
            scene.style.setProperty('--orbit-radius', `${state.radius * centerScale}px`);
            scene.style.setProperty('--orbit-face-offset', `${state.cardLayout.faceOffset * centerScale}px`);
        }

        function applyCardDimensions() {
            if (!state.cardLayout) return;
            const dimensions = cardDimensionsFromScale(state.cardLayout, state.cardScale);
            for (const [name, value] of [
                ['--orbit-card-width', dimensions.cardWidth], ['--orbit-card-height', dimensions.cardHeight],
                ['--orbit-footer-height', dimensions.footerHeight]
            ]) scene.style.setProperty(name, `${value}px`);
        }

        function setCardScale(scale) {
            state.cardScale = clamp(scale, MIN_CARD_SCALE, MAX_CARD_SCALE);
            scene.dataset.cardScale = String(state.cardScale);
            // Only explicit size changes write inherited dimension variables.
            // Animation still updates cached transforms/leaf opacity once per frame.
            applyCardDimensions();
            updateControls();
            queuePreferencesSave();
        }

        function decorateCard(card, index) {
            if (card.classList.contains('orbit-card')) return;
            const title = card.querySelector('button')?.textContent.trim() || card.querySelector('img')?.alt || '影视推荐';
            const front = document.createElement('div');
            front.className = 'orbit-card-front';
            while (card.firstChild) front.appendChild(card.firstChild);
            const ordinal = document.createElement('span');
            ordinal.className = 'orbit-card-number';
            ordinal.textContent = String(index + 1).padStart(2, '0');
            ordinal.setAttribute('aria-hidden', 'true');
            front.appendChild(ordinal);

            // Every position now shows the same readable original face. Do not
            // clone posters, text or actions for an unused mirror/back layer.
            card.appendChild(front);
            card.classList.add('orbit-card');
            card.tabIndex = 0;
            card.setAttribute('role', 'group');
            card.setAttribute('aria-label', title);
            // Both images AND links are native drag sources. Keep their original
            // click handlers/hrefs, but reserve dragging for the sphere gesture.
            card.draggable = false;
            front.querySelectorAll('img, a').forEach(element => { element.draggable = false; });
        }

        function layout() {
            if (capacityTest && scene.dataset.orbitTestLoading === 'true') return;
            const slots = createSlots(state.cards.length);
            const layoutForMode = referenceTest ? computeReferenceLayout : computeLayout;
            state.cardLayout = layoutForMode(scene.clientWidth, scene.clientHeight, slots);
            const { radius, perspective } = state.cardLayout;
            state.radius = radius;
            applySceneScale(true);
            applyCardDimensions();
            scene.style.perspective = `${Math.max(1, perspective)}px`;
            state.positions = slots.map(slot => positionOnSphere(slot, radius));
            paint();
        }

        function reconcileCards() {
            if (capacityTest && scene.dataset.orbitTestLoading === 'true') return;
            const cards = Array.from(container.children).filter(child => child.hasAttribute('data-orbit-card') || child.querySelector('img') ||
                (placeholderTest && child.dataset.orbitPlaceholder === 'true'));
            // Limit only the real homepage presentation, in original DOM/data
            // order. Do not change source data, requests or original actions.
            // Remove excess carriers before decoration and geometry work, rather
            // than retaining thousands of hidden cards in the animation loop.
            state.cards = placeholderTest ? cards : cards.slice(0, MAX_DISPLAY_CARDS);
            if (!placeholderTest && cards.length > MAX_DISPLAY_CARDS) {
                cardObserver.disconnect();
                try { cards.slice(MAX_DISPLAY_CARDS).forEach(card => card.remove()); }
                finally { cardObserver.observe(container, { childList: true }); }
            }
            state.cards.forEach(decorateCard);
            state.faces = state.cards.map(card => card.querySelector('.orbit-card-front'));
            counter.textContent = String(state.cards.length).padStart(2, '0');
            loading.hidden = !Array.from(container.children).some(child => !child.classList.contains('orbit-card') && child.classList.contains('absolute'));
            scene.dataset.state = state.cards.length ? 'ready' : 'empty';
            layout();
            state.previousTime = 0;
            schedule();
        }

        function pointerDistance() {
            const [first, second] = Array.from(pointers.values());
            return Math.hypot(first.x - second.x, first.y - second.y);
        }

        function capture(pointerId) {
            try { scene.setPointerCapture(pointerId); } catch { /* A pointer may already have ended. */ }
        }

        function rememberDirection(vector) {
            const length = Math.hypot(...vector);
            if (length > 1e-12) {
                state.autoDirection = vector.map(value => value / length);
                state.autoVelocity = state.autoDirection.map(value => value * autoSpeedFromPercent(state.speedPercent));
            }
        }

        listen(scene, 'pointerdown', event => {
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            // Cancel mouse defaults before the first movement can start a native
            // image/link drag. Pointer-event cancellation does not cancel click.
            // Do NOT capture yet: a simple click must still target the original
            // poster/button/link rather than being retargeted to the scene.
            if (event.pointerType === 'mouse') event.preventDefault();
            pointers.set(event.pointerId, {
                x: event.clientX, y: event.clientY,
                startX: event.clientX, startY: event.clientY, startTime: event.timeStamp, time: event.timeStamp
            });
            state.previousTime = 0;
            if (pointers.size >= 2) {
                state.pinching = true;
                state.dragging = false;
                state.velocity = [0, 0, 0];
                state.pinchDistance = pointerDistance();
                state.pinchZoom = state.zoom;
                state.suppressClickUntil = performance.now() + 450;
                for (const pointerId of pointers.keys()) capture(pointerId);
                scene.classList.add('is-dragging');
            }
        }, { capture: true, passive: false });

        listen(scene, 'pointermove', event => {
            const pointer = pointers.get(event.pointerId);
            if (!pointer) return;
            let horizontal = event.clientX - pointer.x;
            let vertical = event.clientY - pointer.y;
            let elapsed = (event.timeStamp - pointer.time) / 1000;
            pointer.x = event.clientX;
            pointer.y = event.clientY;
            pointer.time = event.timeStamp;
            if (state.pinching && pointers.size >= 2) {
                event.preventDefault();
                setZoom(zoomFromPinch(state.pinchZoom, state.pinchDistance, pointerDistance()));
                state.suppressClickUntil = performance.now() + 450;
                return;
            }
            if (!state.dragging) {
                horizontal = event.clientX - pointer.startX;
                vertical = event.clientY - pointer.startY;
                if (Math.hypot(horizontal, vertical) < DRAG_THRESHOLD) return;
                elapsed = (event.timeStamp - pointer.startTime) / 1000;
                state.dragging = true;
                state.velocity = [0, 0, 0];
                capture(event.pointerId);
                scene.classList.add('is-dragging');
            }
            event.preventDefault();
            const rotation = gestureVector(horizontal, vertical);
            state.orientation = rotateOrientation(state.orientation, rotation);
            if (Math.hypot(horizontal, vertical) > 0.2) {
                rememberDirection(rotation);
                const velocity = velocityFromGesture(horizontal, vertical, elapsed);
                state.velocity = state.velocity.map((value, axis) => value * 0.35 + velocity[axis] * 0.65);
            }
            state.suppressClickUntil = performance.now() + 450;
            // Input may arrive much faster than the screen refresh rate. Keep
            // every rotation sample, but commit DOM/style changes once per frame.
            requestPaint();
        }, { passive: false });

        function finishPointer(event) {
            // A capture transfer emits a BUBBLING loss on the old child owner.
            // That is not pointer cancellation or the end of our new capture.
            // Also ignore a loss if capture has already been re-established.
            if (event.type === 'lostpointercapture' &&
                (event.target !== scene || scene.hasPointerCapture(event.pointerId))) return;
            if (!pointers.has(event.pointerId)) return;
            const lastPointer = pointers.get(event.pointerId);
            const wasGesture = state.dragging || state.pinching;
            if (event.type !== 'pointerup' || (state.dragging && (event.timeStamp - lastPointer.time) > 100)) {
                state.velocity = state.autoVelocity.slice();
            } else if (state.dragging) {
                rememberDirection(state.velocity);
            }
            pointers.delete(event.pointerId);
            if (state.pinching && pointers.size < 2) {
                state.pinching = false;
                for (const point of pointers.values()) {
                    point.startX = point.x;
                    point.startY = point.y;
                    point.time = event.timeStamp;
                    point.startTime = event.timeStamp;
                }
            }
            state.dragging = false;
            scene.classList.remove('is-dragging');
            if (wasGesture) state.suppressClickUntil = performance.now() + 450;
            state.previousTime = 0;
            schedule();
            savePreferences();
        }

        listen(scene, 'pointerup', finishPointer);
        listen(scene, 'pointercancel', finishPointer);
        listen(scene, 'lostpointercapture', finishPointer);
        // Capture phase runs even if a descendant stops dragstart propagation.
        listen(scene, 'dragstart', event => event.preventDefault(), { capture: true });
        listen(scene, 'click', event => {
            if (performance.now() < state.suppressClickUntil) {
                event.preventDefault();
                event.stopImmediatePropagation();
                return;
            }
            // Empty carrier space keeps the card action. Content buttons, links
            // and poster wrappers retain their original handlers without relaying
            // their clicks recursively or duplicating search/API logic.
            const card = event.target.closest('.orbit-card');
            if (card && event.target === card) {
                card.querySelector('.orbit-card-front button')?.click();
            }
        }, true);

        listen(scene, 'wheel', event => {
            if (!event.ctrlKey && !event.metaKey && !event.altKey) return;
            event.preventDefault();
            const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scene.clientHeight : 1);
            setZoom(state.zoom * Math.exp(-delta * 0.002));
        }, { passive: false });

        listen(scene, 'keydown', event => {
            const card = event.target.closest('.orbit-card');
            if (card && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                card.querySelector('.orbit-card-front button')?.click();
                return;
            }
            if (event.target !== scene) return;
            const arrows = { ArrowLeft: [0, -1, 0], ArrowRight: [0, 1, 0], ArrowUp: [1, 0, 0], ArrowDown: [-1, 0, 0] };
            if (arrows[event.key]) {
                event.preventDefault();
                const axis = arrows[event.key];
                state.orientation = rotateOrientation(state.orientation, axis.map(value => value * 0.18));
                state.velocity = axis.map(value => value * 0.5);
                rememberDirection(axis);
                state.previousTime = 0;
                requestPaint();
            } else if (event.key === '+' || event.key === '=') {
                event.preventDefault();
                setZoom(state.zoom + 0.1);
            } else if (event.key === '-') {
                event.preventDefault();
                setZoom(state.zoom - 0.1);
            } else if (event.key === ' ') {
                event.preventDefault();
                pauseButton.click();
            }
            savePreferences();
        });

        listen(container, 'focusin', event => {
            state.focused = Boolean(event.target.closest('.orbit-card') && event.target.matches(':focus-visible'));
        });
        listen(container, 'focusout', () => {
            state.focused = false;
            state.previousTime = 0;
            schedule();
        });

        listen(controls, 'click', event => {
            const action = event.target.closest('[data-orbit-action]')?.dataset.orbitAction;
            if (action === 'zoom-in') setZoom(state.zoom + 0.1);
            if (action === 'zoom-out') setZoom(state.zoom - 0.1);
            if (action === 'reset') {
                if (placeholderTest) setZoom(1);
                else {
                    const defaults = homeDefaults();
                    setZoom(defaults.zoom);
                    setCardScale(defaults.cardScale);
                    setAutoSpeed(DEFAULT_SPEED_PERCENT);
                }
            }
            if (action === 'card-size-in') setCardScale(Math.round((state.cardScale + 0.1) * 100) / 100);
            if (action === 'card-size-out') setCardScale(Math.round((state.cardScale - 0.1) * 100) / 100);
            if (action === 'card-size-reset') setCardScale(1);
            if (action === 'speed-in') setAutoSpeed(state.speedPercent + 10);
            if (action === 'speed-out') setAutoSpeed(state.speedPercent - 10);
            if (action === 'pause') {
                state.paused = !state.paused;
                state.previousTime = 0;
                updateControls();
                schedule();
                queuePreferencesSave();
            }
            savePreferences();
        });

        const cardObserver = new global.MutationObserver(reconcileCards);
        cardObserver.observe(container, { childList: true });
        if (capacityTest) {
            // Prepare a bounded batch offscreen; only the completed fixture set
            // triggers geometry/paint. Production/API mutation handling is intact.
            listen(scene, 'orbit-fixtures-batch', event => {
                if (scene.dataset.orbitTestLoading !== 'true') return;
                event.detail.cards.forEach((card, index) => decorateCard(card, event.detail.start + index));
            });
            listen(scene, 'orbit-fixtures-ready', () => {
                state.paused = true;
                updateControls();
                reconcileCards();
            });
        }
        const resizeObserver = new global.ResizeObserver(layout);
        resizeObserver.observe(scene);
        const intersectionObserver = new global.IntersectionObserver(entries => {
            state.visible = entries[0].isIntersecting;
            state.previousTime = 0;
            schedule();
        });
        intersectionObserver.observe(scene);
        listen(document, 'visibilitychange', () => {
            if (document.hidden) savePreferences();
            state.previousTime = 0;
            schedule();
        });
        listen(global, 'pagehide', savePreferences);
        listen(reduceMotion, 'change', event => {
            state.paused = event.matches;
            state.previousTime = 0;
            updateControls();
            schedule();
        });
        // Keep manual sizes across viewport changes; only the reset target updates.
        listen(mobileLayout, 'change', updateControls);

        const defaults = homeDefaults();
        const saved = readPreferences();
        // A saved, explicit pause/resume choice takes precedence over the initial
        // reduced-motion default. Toolbar disclosure still starts collapsed.
        if (saved.paused !== undefined) state.paused = saved.paused;
        setZoom(capacityTest ? MAX_ZOOM : referenceTest ? 2 : placeholderTest ? 1 : saved.zoom ?? defaults.zoom);
        setCardScale(capacityTest ? MIN_CARD_SCALE : referenceTest ? 0.5 : placeholderTest ? 1 : saved.cardScale ?? defaults.cardScale);
        setAutoSpeed(saved.speedPercent ?? DEFAULT_SPEED_PERCENT);
        preferencesReady = true;
        reconcileCards();
        return {
            refresh: reconcileCards,
            destroy() {
                if (destroyed) return;
                destroyed = true;
                savePreferences();
                if (state.frame) global.cancelAnimationFrame(state.frame);
                if (preferencesTimer) global.clearTimeout(preferencesTimer);
                state.frame = 0;
                state.cards = []; state.faces = []; state.positions = [];
                listeners.forEach(remove => remove());
                cardObserver.disconnect(); resizeObserver.disconnect(); intersectionObserver.disconnect();
                for (const pointerId of pointers.keys()) {
                    try { scene.releasePointerCapture(pointerId); } catch { /* pointer already ended */ }
                }
                pointers.clear();
                scene.classList.remove("is-dragging");
                delete scene.dataset.orbitReady;
            }
        };
}
