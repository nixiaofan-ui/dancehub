const {PrismaClient}=require('@prisma/client');
const p=new PrismaClient();
(async()=>{
const {assignBrands,brandKey}=await import('../src/lib/studio-name.js');
const studios=await p.studio.findMany({where:{status:true},select:{id:true,name:true,cityId:true}});
const cities=await p.city.findMany({select:{id:true,name:true}});
const cn=new Map(cities.map(c=>[c.id,c.name]));
const byCity=new Map();
for(const s of studios){ if(!byCity.has(s.cityId)) byCity.set(s.cityId,[]); byCity.get(s.cityId).push(s); }
const owner=new Map(); const brands=[];
for(const [cid,list] of byCity){
  for(const [id,v] of assignBrands(list)){ owner.set(id,brandKey(v.brand)); }
  const g=new Map();
  for(const s of list){ const k=owner.get(s.id); if(!k) continue; if(!g.has(k)) g.set(k,[]); g.get(k).push(s.name); }
  for(const [k,v] of g) if(v.length>=2) brands.push({city:cn.get(cid),k,n:v.length,stores:v});
}
console.log('品牌组总数:',brands.length);
const norm=s=>String(s).replace(/[^0-9A-Za-z\u4e00-\u9fa5]/g,'').toLowerCase();
const out=[];
for(const [cid,list] of byCity){
  for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++){
    const a=norm(list[i].name), b=norm(list[j].name);
    let k=0; while(k<a.length&&k<b.length&&a[k]===b[k])k++;
    if(k<4) continue;
    const oa=owner.get(list[i].id), ob=owner.get(list[j].id);
    if(oa&&oa===ob) continue;
    out.push({city:cn.get(cid),pre:list[i].name.slice(0,Math.min(k,12)),a:list[i].name,b:list[j].name,k});
  }
}
out.sort((x,y)=>y.k-x.k);
console.log('仍漏合的同城门店对:',out.length);
const seen=new Set();
out.forEach(o=>{const key=o.city+'|'+o.pre; if(seen.has(key))return; seen.add(key);
  console.log(' ['+o.city+'] 「'+o.pre+'」 '+o.a+'  ×  '+o.b);});
await p.$disconnect();
})();
