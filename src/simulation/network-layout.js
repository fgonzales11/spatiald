// Harmonic interpolation collapses unanchored branches onto their junction.
// Expand those branches as an explicitly schematic, deterministic display copy.
// Electrical identities, line lengths, solver inputs and noncollapsed routes stay intact.
const M=111320;
export function layoutDistributionGeometry(geometry){
  const features=geometry.solver?.features||[];
  const edges=features.filter(f=>f.geometry.type==='LineString'&&f.geometry.coordinates.length>=2);
  if(!edges.length)return geometry;
  const origin=edges[0].geometry.coordinates[0],cos=Math.cos(origin[1]*Math.PI/180);
  const local=p=>[(p[0]-origin[0])*M*cos,(p[1]-origin[1])*M];
  const geo=p=>[origin[0]+p[0]/(M*cos),origin[1]+p[1]/M];
  const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
  const parent=new Map(),points=new Map();
  const find=id=>{if(!parent.has(id))parent.set(id,id);if(parent.get(id)!==id)parent.set(id,find(parent.get(id)));return parent.get(id);};
  for(const f of edges){const p=f.properties,r=f.geometry.coordinates;for(const [id,pos]of [[p.from_bus,r[0]],[p.to_bus,r.at(-1)]]){find(id);if(!points.has(id))points.set(id,local(pos));}}
  for(const f of edges){const p=f.properties;if(p.kind!=='line'&&distance(points.get(p.from_bus),points.get(p.to_bus))<6)parent.set(find(p.to_bus),find(p.from_bus));}
  const nodes=new Map();for(const [id,pos]of points){const root=find(id);if(!nodes.has(root))nodes.set(root,{id:root,original:pos,position:[...pos],links:[],fixed:false});}
  const links=[],collapsed=[];
  for(const f of edges){const p=f.properties,a=nodes.get(find(p.from_bus)),b=nodes.get(find(p.to_bus));if(a===b||p.kind!=='line')continue;
    const length=Number(p.length_m),d=distance(a.original,b.original);
    const collapse=length>0&&d<Math.max(1,Math.min(6,length*.03));
    const link={a,b,length:Math.max(15,Math.min(150,Number.isFinite(length)?length:40)),collapse};
    links.push(link);a.links.push(link);b.links.push(link);
    if(collapse)collapsed.push(link);else{a.fixed=true;b.fixed=true;}
  }
  if(!collapsed.length)return geometry;
  const free=new Set(collapsed.flatMap(e=>[e.a,e.b]).filter(n=>!n.fixed));
  const visited=new Set([...nodes.values()].filter(n=>n.fixed));
  const queue=[...visited].filter(n=>n.links.some(e=>e.collapse));
  const hash=id=>{let h=2166136261;for(const c of String(id))h=Math.imul(h^c.charCodeAt(0),16777619);return (h>>>0)/4294967296;};
  const spread=()=>{
    for(let i=0;i<queue.length;i++){
      const node=queue[i],children=node.links.map(e=>({link:e,next:e.a===node?e.b:e.a})).filter(v=>free.has(v.next)&&!visited.has(v.next));
      // Reserve children before laying out: cycles retain their closing edges.
      const unique=children.filter(({next})=>{if(visited.has(next))return false;visited.add(next);return true;});
      unique.sort((a,b)=>String(a.next.id).localeCompare(String(b.next.id),'en',{numeric:true}));
      const base=node.angle??hash(node.id)*Math.PI*2,fan=node.angle===undefined?Math.PI*2:Math.min(Math.PI*1.5,.8*Math.max(1,unique.length));
      unique.forEach(({next,link},j)=>{const angle=base+(unique.length===1?0:((j+.5)/unique.length-.5)*fan);next.position=[node.position[0]+Math.cos(angle)*link.length,node.position[1]+Math.sin(angle)*link.length];next.angle=angle;queue.push(next);});
    }
  };
  spread();
  // Completely unanchored components retain their original circuit location.
  for(const node of free)if(!visited.has(node)){node.fixed=true;free.delete(node);visited.add(node);queue.length=0;queue.push(node);spread();}
  // Local repulsion prevents adjacent branches from being drawn on top of each other.
  // A spatial hash keeps this bounded for the largest imported circuits.
  const cell=40;
  for(let iteration=0;iteration<100;iteration++){
    const delta=new Map([...free].map(n=>[n,[0,0]])),grid=new Map();
    for(const n of nodes.values()){const [x,y]=n.position,key=`${Math.floor(x/cell)},${Math.floor(y/cell)}`;if(!grid.has(key))grid.set(key,[]);grid.get(key).push(n);}
    for(const {a,b,length}of links){if(!free.has(a)&&!free.has(b))continue;const dx=b.position[0]-a.position[0],dy=b.position[1]-a.position[1],d=Math.hypot(dx,dy)||.01,force=(d-length)*.08;
      for(const [n,sign]of [[a,1],[b,-1]])if(delta.has(n)){const v=delta.get(n);v[0]+=sign*dx/d*force;v[1]+=sign*dy/d*force;}}
    for(const n of free){const [x,y]=n.position,gx=Math.floor(x/cell),gy=Math.floor(y/cell),v=delta.get(n);
      for(let a=-1;a<=1;a++)for(let b=-1;b<=1;b++)for(const other of grid.get(`${gx+a},${gy+b}`)||[]){if(other===n)continue;let dx=x-other.position[0],dy=y-other.position[1],d=Math.hypot(dx,dy);if(d>=30)continue;if(d<.01){const t=hash(n.id)*Math.PI*2;dx=Math.cos(t)*.01;dy=Math.sin(t)*.01;d=.01;}const force=(30-d)*.12;v[0]+=dx/d*force;v[1]+=dy/d*force;}}
    for(const [n,v]of delta){const scale=Math.min(1,5/(Math.hypot(...v)||1));n.position[0]+=v[0]*scale;n.position[1]+=v[1]*scale;}
  }
  const moved=new Set([...points.keys()].filter(id=>distance(points.get(id),nodes.get(find(id)).position)>.05));
  if(!moved.size)return geometry;
  const rendered=features.map(f=>{
    const p=f.properties;if(!moved.has(p.from_bus)&&!moved.has(p.to_bus))return f;
    const path=f.geometry.coordinates,a=geo(nodes.get(find(p.from_bus)).position),b=geo(nodes.get(find(p.to_bus)).position),oldA=path[0],oldB=path.at(-1);
    return {...f,properties:{...p,coordinate_source:'schematic_solver_layout'},geometry:{...f.geometry,coordinates:path.map((v,i)=>{const t=i/(path.length-1);return [v[0]+(a[0]-oldA[0])*(1-t)+(b[0]-oldB[0])*t,v[1]+(a[1]-oldA[1])*(1-t)+(b[1]-oldB[1])*t,v[2]??0];})}};
  });
  const bounds=[Infinity,Infinity,-Infinity,-Infinity];
  for(const f of rendered)for(const [x,y]of f.geometry.coordinates){bounds[0]=Math.min(bounds[0],x);bounds[1]=Math.min(bounds[1],y);bounds[2]=Math.max(bounds[2],x);bounds[3]=Math.max(bounds[3],y);}
  return {...geometry,display_bounds:bounds,solver:{...geometry.solver,features:rendered},provenance:{...geometry.provenance,schematic_layout_buses:moved.size,expanded_collapsed_lines:collapsed.length,layout_note:`${moved.size.toLocaleString()} buses use a schematic branch layout because source coordinates are missing or collapsed. Branch locations are illustrative; use GIS circuit route for the recorded geographic footprint.`}};
}
