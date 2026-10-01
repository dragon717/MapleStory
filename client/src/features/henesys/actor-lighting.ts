/** Pixel art receives world light before the crisp foreground capture; labels do not. */
export type ActorLightSample = {position:readonly number[];intensity:number;distance:number;color:readonly number[]};
export type ArtLight = {r:number;g:number;b:number};
const srgb=(v:number)=>v<=.0031308?v*12.92:1.055*Math.pow(v,1/2.4)-.055;
export function sampleActorLight(point:readonly number[],daylight:number,samples:readonly ActorLightSample[],out:ArtLight):ArtLight{
 const day=Math.max(0,Math.min(1,daylight));
 let r=.018+day*.87,g=.024+day*.88,b=.041+day*.86;
 for(const lamp of samples){
  const d=Math.hypot(point[0]-lamp.position[0],point[1]+1-lamp.position[1],point[2]-lamp.position[2]);
  // Match Three's inverse-square decay and smooth distance cutoff; range is a radius in metres.
  const cutoff=lamp.distance>0?Math.pow(Math.max(0,1-Math.pow(d/lamp.distance,4)),2):1;
  const light=Math.min(2,lamp.intensity/Math.max(d*d,.04)*cutoff)*.23;
  r+=lamp.color[0]*light;g+=lamp.color[1]*light;b+=lamp.color[2]*light;
 }
 out.r=srgb(Math.min(1,r));out.g=srgb(Math.min(1,g));out.b=srgb(Math.min(1,b));return out;
}
export function multiplyArtTint(tint:number,light:ArtLight){
 return Math.round((tint>>16&255)*light.r)<<16|Math.round((tint>>8&255)*light.g)<<8|Math.round((tint&255)*light.b);
}
