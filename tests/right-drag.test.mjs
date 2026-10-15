import test from 'node:test';
import assert from 'node:assert/strict';
import {reverseMapLibreRightDrag,reverseGlobeRightDrag} from '../src/spatial/right-drag.js';

test('right mouse reverses actual MapLibre movement deltas, preserving inertia inputs and other gestures',()=>{
  const handlers=Object.fromEntries(['_mouseRotate','_mousePitch','_mouseRoll'].map(key=>[key,{enabled:true,mousemoveWindow(event,result){return this.enabled?result:undefined;}}]));
  const original=handlers._mouseRotate.mousemoveWindow,restore=reverseMapLibreRightDrag({dragRotate:handlers});
  for(const bearingDelta of [-9,9]) {
    const movement={bearingDelta,pitchDelta:-4,rollDelta:2,around:{x:1,y:2}};
    assert.deepEqual(handlers._mouseRotate.mousemoveWindow({buttons:2},movement),{...movement,bearingDelta:-bearingDelta,pitchDelta:4,rollDelta:-2});
    assert.equal(handlers._mouseRotate.mousemoveWindow({buttons:1,ctrlKey:true},movement),movement);
  }
  handlers._mousePitch.enabled=false;
  assert.equal(handlers._mousePitch.mousemoveWindow({buttons:2},{pitchDelta:8}),undefined);
  restore();assert.equal(handlers._mouseRotate.mousemoveWindow,original);
});

test('GlobeControls reverses only right-drag rotation and keeps its sign during inertia',()=>{
  const element=new EventTarget(),controls={rotationSpeed:1};
  const restore=reverseGlobeRightDrag(controls,element);
  const event=(type,button,pointerType='mouse')=>Object.assign(new Event(type),{button,pointerType});
  element.dispatchEvent(event('pointerdown',2));assert.equal(controls.rotationSpeed,-1);
  element.dispatchEvent(event('pointerup',2));assert.equal(controls.rotationSpeed,-1);
  element.dispatchEvent(event('pointerdown',0));assert.equal(controls.rotationSpeed,1);
  element.dispatchEvent(event('pointerdown',2,'touch'));assert.equal(controls.rotationSpeed,1);
  element.dispatchEvent(event('pointerdown',2));restore();assert.equal(controls.rotationSpeed,1);
  element.dispatchEvent(event('pointerdown',2));assert.equal(controls.rotationSpeed,1);
});
