import test from 'node:test';
import assert from 'node:assert/strict';
import {createTronScene} from '../src/spatial/tron-scene.js';

test('TRON renders steady success/failure glow and never schedules moving flow markers, even with legacy animation enabled',async()=>{
  const previousDocument=globalThis.document,previousRaf=globalThis.requestAnimationFrame;
  let frames=0,layers=[];
  globalThis.document={createElement:()=>({remove(){}})};
  globalThis.requestAnimationFrame=()=>++frames;
  const host={dataset:{},clientHeight:600,append(){}};
  const map={isStyleLoaded:()=>true,getContainer:()=>host,getCanvas:()=>({setAttribute(){}}),on(){},off(){},getLayer(){},
    getStyle:()=>({sources:{}}),getZoom:()=>12,getCenter:()=>({lng:-118,lat:34}),
    getBounds:()=>({getWest:()=>-118.01,getEast:()=>-117.99,getSouth:()=>33.99,getNorth:()=>34.01}),getSource(){}};
  const feature={type:'Feature',id:'recorded-route',properties:{kind:'line',from_bus:'a',to_bus:'b',construction:'overhead',coordinate_source:'gis_reference'},geometry:{type:'LineString',coordinates:[[-118,34],[-118.001,34.001]]}};
  const scene=createTronScene(map,{settings:{animated:true},setLayers:value=>{layers=value;}});
  try{
    const state={visible:true,status:'converged',topology:'solver',geometry:{solver:{features:[feature]}}};
    await scene.set(state);
    assert.ok(layers.find(l=>l.id==='tron-network-glow').props.data.length>0);
    assert.deepEqual(layers.find(l=>l.id==='tron-network').props.data[0].color,[61,255,150,255]);
    assert.equal(layers.some(l=>l.id==='tron-network-current'),false);assert.equal(frames,0);
    assert.equal(host.dataset.simulationAnimation,'none');assert.equal(host.dataset.tronAnimatedEnabled,'false');
    scene.configure({animated:true});assert.equal(frames,0);
    await scene.set({...state,status:'nonconverged'});
    assert.ok(layers.find(l=>l.id==='tron-network-glow').props.data.length>0);
    assert.deepEqual(layers.find(l=>l.id==='tron-network').props.data[0].color,[255,76,97,255]);
    await scene.set({...state,visible:false});assert.equal(layers.some(l=>l.id==='tron-network'),false);
  }finally{scene.dispose();globalThis.document=previousDocument;globalThis.requestAnimationFrame=previousRaf;}
});
