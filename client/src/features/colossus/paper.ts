import * as T from 'three';

export interface PaperFrame { texture: T.CanvasTexture; face: T.BufferGeometry; edge: T.BufferGeometry }
/** Original pixels and foot origin, with only a thin opaque silhouette edge added. */
export function paperFrame(canvas: HTMLCanvasElement, left: number, top: number, unit: number, thickness: number): PaperFrame {
    const {width:w,height:h}=canvas, pixels=canvas.getContext('2d')!.getImageData(0,0,w,h).data;
    const texture=new T.CanvasTexture(canvas);texture.colorSpace=T.SRGBColorSpace;texture.magFilter=T.LinearFilter;
    const face=new T.PlaneGeometry(w*unit,h*unit);face.translate((left+w/2)*unit,-(top+h/2)*unit,thickness/2);
    const positions:number[]=[], colors:number[]=[];
    const alpha=(x:number,y:number)=>x>=0&&y>=0&&x<w&&y<h?pixels[(y*w+x)*4+3]/255:0;
    // Interpolate the alpha contour inside each pixel cell: no square pixel extrusion.
    const cases=[[],[3,0],[0,1],[3,1],[1,2],[3,0,1,2],[0,2],[3,2],[2,3],[2,0],[0,1,2,3],[2,1],[1,3],[1,0],[0,3],[]];
    for(let y=-1;y<h;y++)for(let x=-1;x<w;x++) {
        const corners=[[x,y],[x+1,y],[x+1,y+1],[x,y+1]], values=corners.map(([x,y])=>alpha(x,y));
        const segments=cases[values.reduce((mask,a,i)=>mask|(a>=.5?1<<i:0),0)];
        const at=(edge:number)=>{const a=edge,b=(edge+1)%4,f=(.5-values[a])/(values[b]-values[a]);return [(left+corners[a][0]+.5+(corners[b][0]-corners[a][0])*f)*unit,-(top+corners[a][1]+.5+(corners[b][1]-corners[a][1])*f)*unit];};
        const sample=corners.find(([x,y])=>alpha(x,y)>=.5);if(!sample)continue;
        const index=(sample[1]*w+sample[0])*4,color=[0,1,2].map(i=>pixels[index+i]/255*.68),z=thickness/2;
        for(let i=0;i<segments.length;i+=2){const a=at(segments[i]),b=at(segments[i+1]),points=[[...a,z],[...b,z],[...b,-z],[...a,-z]];for(const j of [0,1,2,0,2,3]){positions.push(...points[j]);colors.push(...color);}}
    }
    const edge=new T.BufferGeometry();edge.setAttribute('position',new T.Float32BufferAttribute(positions,3));edge.setAttribute('color',new T.Float32BufferAttribute(colors,3));edge.computeVertexNormals();
    return {texture,face,edge};
}
export class PaperActor extends T.Group {
    readonly front=new T.Mesh(new T.BufferGeometry(),new T.MeshLambertMaterial({alphaTest:.05,alphaToCoverage:true,side:T.DoubleSide,emissive:0xffffff,emissiveIntensity:.16}));
    readonly rim=new T.Mesh(new T.BufferGeometry(),new T.MeshLambertMaterial({vertexColors:true,side:T.DoubleSide}));
    constructor(){super();this.add(this.front,this.rim);this.visible=false;}
    show(frame:PaperFrame){if(this.front.material.map!==frame.texture){this.front.geometry=frame.face;this.rim.geometry=frame.edge;this.front.material.map=frame.texture;this.front.material.emissiveMap=frame.texture;this.front.material.needsUpdate=true;}this.visible=true;}
    faceCamera(camera:T.Camera, facing:number){this.rotation.y=Math.atan2(camera.position.x-this.position.x,camera.position.z-this.position.z)+.12;this.scale.x=facing>0?-Math.abs(this.scale.x):Math.abs(this.scale.x);}
    dispose(){this.front.material.dispose();this.rim.material.dispose();this.removeFromParent();}
}
export function disposePaper(frame:PaperFrame){frame.texture.dispose();frame.face.dispose();frame.edge.dispose();}
