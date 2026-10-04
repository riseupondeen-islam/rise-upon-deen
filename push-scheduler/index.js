const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
  throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON secret is missing or invalid.');
}
if (!getApps().length) initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
const messaging = getMessaging();

const PUSH_COLLECTION = 'push_subscriptions';
const JOB_COLLECTION = 'push_jobs';
const DELIVERY_COLLECTION = 'push_prayer_deliveries';
const PRAYER_KEYS = ['fajr','dhuhr','asr','maghrib','isha'];
const PRAYER_LABELS = {fajr:'Fajr',dhuhr:'Dhuhr',asr:'Asr',maghrib:'Maghrib',isha:'Isha'};
const ALADHAN_BASE = 'https://api.aladhan.com/v1/timings';

function cleanTime(value){
  const m=String(value||'').match(/^(\d{1,2}):(\d{2})$/); if(!m)return '';
  const h=Number(m[1]),min=Number(m[2]); if(h>23||min>59)return '';
  return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
}
function zoneParts(date,timeZone){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date);
  return Object.fromEntries(parts.map(p=>[p.type,p.value]));
}
function localNow(timeZone){
  const p=zoneParts(new Date(),timeZone||'UTC');
  return {date:`${p.year}-${p.month}-${p.day}`,hour:Number(p.hour),minute:Number(p.minute)};
}
function apiDate(date){const m=String(date).match(/^(\d{4})-(\d{2})-(\d{2})$/);return m?`${m[3]}-${m[2]}-${m[1]}`:'';}
function validPrayers(prayers){return PRAYER_KEYS.every(k=>!!cleanTime(prayers?.timings?.[k]));}
function minuteDistance(h,m,t){const [th,tm]=t.split(':').map(Number);return h*60+m-(th*60+tm);}

async function fetchPrayerTimes({date,lat,lng,method,school}){
  const latitude=Number(lat),longitude=Number(lng);
  if(!Number.isFinite(latitude)||!Number.isFinite(longitude))return null;
  const params=new URLSearchParams({latitude:String(latitude),longitude:String(longitude),method:String(Number.isFinite(Number(method))?Number(method):4),school:String(Number(school)===1?1:0)});
  const response=await fetch(`${ALADHAN_BASE}/${apiDate(date)}?${params.toString()}`,{headers:{accept:'application/json'}});
  if(!response.ok)throw new Error(`AlAdhan HTTP ${response.status}`);
  const json=await response.json(),data=json?.data;
  if(!data?.timings)throw new Error('AlAdhan returned no timings');
  const timings={};
  for(const key of PRAYER_KEYS){const label=key[0].toUpperCase()+key.slice(1);timings[key]=cleanTime(data.timings[label]);}
  if(!validPrayers({timings}))return null;
  return {date,timeZone:String(data.meta?.timezone||''),timings,method:Number(data.meta?.method?.id??method??4),school:Number(school)===1?1:0,lat:Math.round(latitude*1000)/1000,lng:Math.round(longitude*1000)/1000};
}

async function ensureTodaySchedule(ref,record,today,cache){
  const schedule=record.schedule||{},existing=schedule.prayers;
  if(existing?.date===today.date&&validPrayers(existing))return existing;
  const lat=Number(schedule.lat??existing?.lat),lng=Number(schedule.lng??existing?.lng);
  if(!Number.isFinite(lat)||!Number.isFinite(lng))return null;
  const method=Number(schedule.method??existing?.method??4),school=Number(schedule.school??existing?.school??0)===1?1:0;
  const key=`${today.date}|${lat.toFixed(3)}|${lng.toFixed(3)}|${method}|${school}`;
  let prayers=cache.get(key);
  if(!prayers){prayers=await fetchPrayerTimes({date:today.date,lat,lng,method,school});if(prayers)cache.set(key,prayers);}
  if(!prayers)return null;
  await ref.set({schedule:{...schedule,timeZone:today.timeZone,lat,lng,method,school,prayers},updatedAt:FieldValue.serverTimestamp()},{merge:true});
  return prayers;
}

async function claimDelivery(visitorId,date,key){
  const id=`${visitorId}_${date}_${key}`.replace(/[^a-zA-Z0-9_-]/g,'_');
  const ref=db.collection(DELIVERY_COLLECTION).doc(id);
  return db.runTransaction(async tx=>{const snap=await tx.get(ref);if(snap.exists)return false;tx.create(ref,{visitorId,prayerDate:date,prayerKey:key,createdAt:FieldValue.serverTimestamp()});return true;});
}
function invalidToken(code){return /registration-token-not-registered|invalid-registration-token|messaging\/invalid-registration-token/.test(String(code||''));}
async function disableToken(docRef){await docRef.set({active:false,fcmToken:null,enabledCategories:[],updatedAt:FieldValue.serverTimestamp()},{merge:true});}

async function sendPrayer(doc,record,key,date){
  const token=String(record.fcmToken||'').trim();if(!token)return false;
  const claimed=await claimDelivery(String(record.visitorId||doc.id),date,key);if(!claimed)return false;
  const label=PRAYER_LABELS[key],dedupeId=`prayer:${date}:${key}`;
  try{
    await messaging.send({token,data:{title:`${label} Prayer`,message:`It is time for ${label}.`,body:`It is time for ${label}.`,category:'prayer',prayerName:key,prayerDate:date,dedupeId,route:'#prayer'},webpush:{headers:{TTL:'900',Urgency:'high'}}});
    return true;
  }catch(error){if(invalidToken(error?.code))await disableToken(doc.ref);else await db.collection(DELIVERY_COLLECTION).doc(`${String(record.visitorId||doc.id)}_${date}_${key}`.replace(/[^a-zA-Z0-9_-]/g,'_')).delete().catch(()=>{});throw error;}
}

async function sendGenericJob(jobRef,job){
  const now=Date.now();
  if(job.status!=='queued')return {skipped:true};
  if(job.scheduledAt){
    const t=Date.parse(job.scheduledAt);
    if(Number.isFinite(t)&&t>now)return {skipped:true};
  }
  const category=String(job.category||'announcement');
  const title=String(job.title||'Rise Upon Deen').slice(0,120);
  const message=String(job.message||'').slice(0,280);
  const route=String(job.route||'#home').startsWith('#')?String(job.route||'#home'):'#home';
  const forceTest=job.forceTest===true;
  let snap=await db.collection(PUSH_COLLECTION).where('active','==',true).get();
  let sent=0,eligible=0;
  for(const doc of snap.docs){
    const r=doc.data()||{};
    if(!r.fcmToken)continue;
    if(job.audience==='single'&&String(r.visitorId||doc.id)!==String(job.targetVisitorId||''))continue;
    const cats=r.schedule?.categories||{};
    if(!forceTest&&cats[category]===false)continue;
    const installed=['android-pwa','ios-home-screen','installed-pwa'].includes(String(r.platform||r.schedule?.platform||''));
    if(job.audience==='app'&&!installed)continue;
    if(job.audience==='browser'&&installed)continue;
    eligible++;
    try{
      await messaging.send({
        token:r.fcmToken,
        data:{title,message,body:message,category,route,dedupeId:String(job.dedupeId||jobRef.id),adminTest:forceTest?'1':'0'},
        webpush:{headers:{TTL:'900',Urgency:forceTest?'high':'normal'}}
      });
      sent++;
    }catch(error){
      if(invalidToken(error?.code))await disableToken(doc.ref);
      else console.warn(`Generic push failed for ${doc.id}`,error?.message||error);
    }
  }
  if(sent>0){
    await jobRef.set({status:'sent',sent,eligible,processedAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp(),lastError:null},{merge:true});
    return {sent,eligible};
  }
  await jobRef.set({
    status:'queued',
    eligible,
    attemptedAt:FieldValue.serverTimestamp(),
    updatedAt:FieldValue.serverTimestamp(),
    lastError:eligible===0?'No active matching FCM subscription was available yet.':'FCM delivery failed for all matching subscriptions; retrying on the next run.'
  },{merge:true});
  return {sent:0,eligible,retry:true};
}
async function processJobs(){
  const snap=await db.collection(JOB_COLLECTION).where('status','==','queued').limit(100).get();
  let sent=0,processed=0;
  for(const doc of snap.docs){try{const r=await sendGenericJob(doc.ref,doc.data()||{});if(r.sent)sent+=r.sent;if(r.skipped)continue;processed++;}catch(e){await doc.ref.set({lastError:String(e?.message||e),attemptedAt:FieldValue.serverTimestamp()},{merge:true});}}
  return {jobs:processed,sent};
}

async function processPrayerNotifications(){
  const snap=await db.collection(PUSH_COLLECTION).where('active','==',true).get();
  if(snap.empty)return {subscribers:0,sent:0};
  const cache=new Map();let sent=0,subscribers=0;
  for(const doc of snap.docs){
    const record=doc.data()||{},schedule=record.schedule||{},categories=schedule.categories||{};
    if(categories.prayer!==true||!record.fcmToken||!schedule.timeZone)continue;
    subscribers++;
    try{
      const today=localNow(String(schedule.timeZone));
      const prayers=await ensureTodaySchedule(doc.ref,record,today,cache);if(!prayers||prayers.date!==today.date)continue;
      for(const key of PRAYER_KEYS){const t=cleanTime(prayers.timings[key]);if(!t)continue;const delta=minuteDistance(today.hour,today.minute,t);
        // GitHub's free scheduler has a minimum 5-minute cadence. A 10-minute catch-up
        // window prevents a normal scheduled-run delay from losing a prayer alert.
        if(delta<0||delta>30)continue;
        try{if(await sendPrayer(doc,record,key,today.date))sent++;}catch(e){console.warn(`Prayer send failed ${doc.id}/${key}`,e?.message||e);}
      }
    }catch(e){console.warn(`Subscriber ${doc.id} failed`,e?.message||e);}
  }
  return {subscribers,sent};
}

(async()=>{
  const jobs=await processJobs();
  const prayers=await processPrayerNotifications();
  console.log(JSON.stringify({ok:true,at:new Date().toISOString(),jobs,prayers}));
})().catch(error=>{console.error(error);process.exit(1);});
