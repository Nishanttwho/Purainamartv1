import { hashSessionId } from '../../lib/mongodb-auth.mjs';
export function addRider(f, id) {
  const rider = { ...f.docs.riders[0], id, name: 'Rider '+id, phone:'9333333'+String(f.docs.riders.length+1).padStart(3,'0') };
  f.docs.riders.push(rider);
  const token=id.padEnd(40,'y'); f.cookie[id]='rsid='+token;
  f.docs.sessions.push({kind:'rider',idHash:hashSessionId(token),ownerId:id,authMethod:'password',createdAt:new Date(),expiresAt:new Date(Date.now()+86400000)});
  return rider;
}
