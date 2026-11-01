import fs from 'node:fs';
const LOG='C:/Users/辰辰洋洋/.dsh/logs';
const nsList=fs.readdirSync(LOG).filter(n=>fs.statSync(LOG+'/'+n).isDirectory());
const T=(ts)=>{const d=new Date(ts+8*3600e3);return d.toISOString().slice(5,23).replace('T',' ')};
for(const ns of nsList){
  const f=LOG+'/'+ns+'/'+(new Date(Date.now()+8*3600e3).toISOString().slice(0,10))+'.log';
  if(!fs.existsSync(f)) continue;
  const rows=[]; for(const l of fs.readFileSync(f,'utf8').split(/\r?\n/)){if(!l.trim())continue; try{rows.push(JSON.parse(l))}catch{}}
  if(!rows.length) continue;
  const ev={}; for(const r of rows){ev[r.event]=(ev[r.event]||0)+1}
  const first=T(rows[0].ts), last=T(rows[rows.length-1].ts);
  console.log(`\n### ${ns}  rows=${rows.length}  ${first} -> ${last}`);
  console.log('  events:',Object.entries(ev).map(([k,v])=>k+'x'+v).join(' '));
  const key=rows.filter(r=>/host\.start|wire\.ready|install\.(request|exec|fail|verify)|check\.done|status\.changed|log\.degraded|batch\./.test(r.event));
  for(const r of key.slice(0,14)) console.log('   ',T(r.ts),r.level,r.event,JSON.stringify(r.fields).replace(/"traceId":"[^"]*",?|"spanId":"[^"]*",?|"seq":\d+,?/g,'').slice(0,170));
  if(key.length>14) console.log('    ...('+(key.length-14)+' more key rows)');
}

