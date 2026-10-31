// Read-only index plans and checks for residue from the previous audit.
import fs from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import { mongoConnectionOptions, mongoCollectionIndexes } from '../lib/mongodb.mjs';
import { rollbackGuard } from './performance-safety.mjs';
const names=new Set(['products_catalogue_order','products_admin_page','categories_public_order','orders_admin_page','orders_customer_page','addresses_customer_default','rider_notifications_page','rider_notifications_unread']);
const config=mongoConnectionOptions(),client=new MongoClient(config.uri,config.options);
const report={measuredAt:new Date().toISOString(),readOnly:true,indexes:[],exactDuplicates:[],prefixOverlaps:[],queries:{},previousAuditResidue:{}};
function stages(plan){const rows=[];function visit(x){if(!x||typeof x!=='object')return;if(x.stage)rows.push({stage:x.stage,...(x.indexName?{index:x.indexName}:{})});for(const [key,value] of Object.entries(x))if(!['filter','indexBounds','slotBasedPlan'].includes(key))if(Array.isArray(value))value.forEach(visit);else visit(value);}visit(plan);return rows;}
function stats(plan){const s=plan.executionStats;return {returned:s.nReturned,documentsExamined:s.totalDocsExamined,keysExamined:s.totalKeysExamined,executionTimeMillis:s.executionTimeMillis,stages:stages(plan.queryPlanner.winningPlan)};}
try{
  await client.connect();const db=rollbackGuard(client,client.db(config.dbName));
  for(const [collection,definitions] of Object.entries(mongoCollectionIndexes)){
    const installed=await db.collection(collection).listIndexes().toArray();
    for(const [keys,options] of definitions.filter(([,options])=>names.has(options.name)))report.indexes.push({collection,name:options.name,keys,installed:installed.some(row=>row.name===options.name&&JSON.stringify(row.key)===JSON.stringify(keys))});
    for(let i=0;i<installed.length;i++)for(let j=i+1;j<installed.length;j++){
      const a=installed[i],b=installed[j],ka=Object.entries(a.key),kb=Object.entries(b.key);
      if(JSON.stringify(ka)===JSON.stringify(kb))report.exactDuplicates.push({collection,indexes:[a.name,b.name]});
      else if(ka.every((entry,k)=>JSON.stringify(entry)===JSON.stringify(kb[k]))||kb.every((entry,k)=>JSON.stringify(entry)===JSON.stringify(ka[k])))report.prefixOverlaps.push({collection,indexes:[a.name,b.name],unique:[!!a.unique,!!b.unique]});
    }
  }
  const user=await db.collection('users').findOne({blockedAt:null}),rider=await db.collection('riders').findOne({isActive:{$ne:false}}),product=await db.collection('products').findOne({});
  const cases=[
    ['catalogue','products',{isActive:{$ne:false},stock:{$gt:0},$or:[{'variants.0':{$exists:false}},{variants:{$elemMatch:{isActive:{$ne:false},stock:{$gt:0}}}}]},{position:1,rank:1,id:1},'products_catalogue_order'],
    ['admin-products','products',{}, {createdAt:-1,id:1},'products_admin_page'],
    ['categories','categories',{isActive:{$ne:false}},{position:1,id:1},'categories_public_order'],
    ['admin-orders','orders',{}, {createdAt:-1,id:1},'orders_admin_page'],
    ['customer-orders','orders',{userId:user?.id||'absent'}, {createdAt:-1,id:1},'orders_customer_page'],
    ['default-address','addresses',{customerId:user?.id||'absent',isDefault:true},null,'addresses_customer_default'],
    ['rider-notifications','riderNotifications',{riderId:rider?.id||'absent'},{createdAt:-1,id:1},'rider_notifications_page'],
    ['rider-unread','riderNotifications',{riderId:rider?.id||'absent',readAt:null},null,'rider_notifications_unread'],
    ['checkout-product','products',{id:product?.id||'absent'},null],
    ['checkout-idempotency','orders',{userId:user?.id||'absent',idempotencyKey:'performance-read-only'},null],
    ['cart-owner','carts',{ownerId:user?.id||'absent'},null],
    ['session-lookup','sessions',{kind:'customer',idHash:'performance-read-only',expiresAt:{$gt:new Date()}},null],
    ['rider-inbox','orders',{status:'Ready for pickup',riderId:null,'riderRejections.riderId':{$ne:rider?.id||'absent'}},{createdAt:-1,id:1}],
    ['rider-delivered','orders',{riderId:rider?.id||'absent',status:'Delivered'},{deliveredAt:-1}]
  ];
  for(const [name,collection,filter,sort,hint] of cases){
    const explain=async chosen=>{let cursor=db.collection(collection).find(filter);if(sort)cursor=cursor.sort(sort);if(chosen)cursor=cursor.hint(chosen);return stats(await cursor.limit(25).explain('executionStats'));};
    report.queries[name]={unhinted:await explain(),...(hint?{addedIndex:await explain(hint),naturalScan:await explain({$natural:1})}:{})};
  }
  for(const [collection,filter] of [
    ['orders',{idempotencyKey:/^performance-/}],['addresses',{$or:[{id:/^performance-/},{line1:'Rollback-only address'}]}],
    ['notifications',{$or:[{orderId:/^performance-/},{eventId:/performance-/}]}],['riderNotifications',{$or:[{orderId:/^performance-/},{eventId:/performance-/}]}],
    ['shoppingPreferences',{$or:[{addressId:/^performance-/},{areaId:/^performance-/}]}]
  ])report.previousAuditResidue[collection]=await db.collection(collection).countDocuments(filter);
  await fs.writeFile('performance/index-review.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({installed:report.indexes,duplicates:report.exactDuplicates,prefixOverlaps:report.prefixOverlaps,residue:report.previousAuditResidue}));
}catch(error){console.error(JSON.stringify({error:error.name,code:error.code,message:'Read-only index review failed; private details withheld'}));process.exitCode=1;}
finally{await client.close();}
