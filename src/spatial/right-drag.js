// Preserve each renderer's orbit model, inertia and gesture enablement. Only the
// deltas from the right mouse button change sign; pan, touch and keyboard do not.
export function reverseMapLibreRightDrag(map) {
  const restorers = [];
  // MapLibre 6.x exposes the mouse handlers through dragRotate. Wrapping the
  // returned deltas also handles orbital rotation away from the screen centre,
  // where the rotateSpeed option is not used by MapLibre.
  for (const handler of [map.dragRotate?._mouseRotate, map.dragRotate?._mousePitch, map.dragRotate?._mouseRoll]) {
    if (!handler?.mousemoveWindow) continue;
    const original = handler.mousemoveWindow;
    handler.mousemoveWindow = function (event, ...args) {
      const result = original.call(this, event, ...args);
      if (!result || !(event.buttons & 2)) return result;
      return Object.fromEntries(Object.entries(result).map(([key, value]) =>
        [key, ['bearingDelta', 'pitchDelta', 'rollDelta'].includes(key) ? -value : value]));
    };
    restorers.push(() => { handler.mousemoveWindow = original; });
  }
  return () => { for (const restore of restorers) restore(); };
}

export function reverseGlobeRightDrag(controls, element) {
  const speed = controls.rotationSpeed;
  const down = event => {
    controls.rotationSpeed = event.pointerType !== 'touch' && event.button === 2 ? -speed : speed;
  };
  element.addEventListener('pointerdown', down, true);
  // Keep the sign until the next gesture so post-release inertia continues in
  // the same direction instead of snapping back when the button is released.
  return () => { element.removeEventListener('pointerdown', down, true); controls.rotationSpeed = speed; };
}
