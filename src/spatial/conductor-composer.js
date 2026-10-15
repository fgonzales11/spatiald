import {LineGlowEffect} from './line-glow.js';
import {createEnvironment} from './environment.js';

// One HDR pipeline keeps the sky, volumetric clouds, and conductor bloom in the
// same depth space. The separate glow pass runs after atmosphere, before AGX.
export function createConductorComposer(options){
  const {scene,camera}=options;
  const glow=new LineGlowEffect(scene,camera,{layer:2,intensity:1,radius:.6,levels:5});
  return Object.assign(createEnvironment({...options,glow}),{glow});
}
