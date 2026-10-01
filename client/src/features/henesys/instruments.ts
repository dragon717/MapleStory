import * as T from 'three';
import { MUSIC_SPOTS } from './coordinates';
export function villageInstruments(){
  const root=new T.Group();root.name='村落乐器';root.userData.layer='props';
  const wood=new T.MeshStandardMaterial({color:0x895430,roughness:.58}),gold=new T.MeshStandardMaterial({color:0xdcb55f,metalness:.7,roughness:.3});
  const mesh=(g:T.Group,geometry:T.BufferGeometry,material:T.Material,x:number,y:number,z:number)=>{const m=new T.Mesh(geometry,material);m.position.set(x,y,z);g.add(m);return m;};
  for(const spot of MUSIC_SPOTS){
    const g=new T.Group();g.name=spot.name;g.position.set(spot.position[0],spot.position[1],spot.position[2]);root.add(g);
    mesh(g,new T.BoxGeometry(2.6,.18,1.8),wood,0,.09,0);
    if(spot.kind==='harp'){
      mesh(g,new T.CylinderGeometry(.11,.16,2.9,8),wood,-.85,1.6,0);
      const arm=mesh(g,new T.BoxGeometry(2,.2,.25),wood,0,2.75,0);arm.rotation.z=-.17;
      mesh(g,new T.BoxGeometry(1.9,.2,.4),wood,0,.35,0);
      for(let i=0;i<10;i++){const x=-.7+i*.16,h=2.25-(x+.7)*.17;mesh(g,new T.CylinderGeometry(.008,.008,h,4),gold,x,.45+h/2,0);}
    }else if(spot.kind==='marimba'){
      for(const x of [-.95,.95])mesh(g,new T.BoxGeometry(.13,.95,.8),wood,x,.65,0);
      for(let i=0;i<12;i++)mesh(g,new T.BoxGeometry(.15,.12,1.2-i*.055),wood,-1+i*.18,1.2,0);
      mesh(g,new T.CylinderGeometry(.018,.018,.55,5),gold,.3,1.35,0).rotation.z=1;
    }else{
      for(const x of [-.95,.95])mesh(g,new T.CylinderGeometry(.07,.09,2.65,8),wood,x,1.5,0);
      mesh(g,new T.BoxGeometry(2.1,.13,.2),wood,0,2.8,0);
      for(let i=0;i<8;i++){const h=.7+(i%4)*.17;mesh(g,new T.CylinderGeometry(.045,.045,h,8),gold,-.75+i*.21,2.5-h/2,0);mesh(g,new T.CylinderGeometry(.005,.005,.3,4),gold,-.75+i*.21,2.65,0);}
    }
  }
  return root;
}
