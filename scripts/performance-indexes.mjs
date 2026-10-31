import { MongoClient } from 'mongodb';
import { mongoConnectionOptions, mongoCollectionIndexes } from '../lib/mongodb.mjs';
const names = new Set(['products_catalogue_order','products_admin_page','categories_public_order','orders_admin_page','orders_customer_page','addresses_customer_default','rider_notifications_page','rider_notifications_unread']);
const selected = Object.entries(mongoCollectionIndexes).flatMap(([collection, indexes]) => indexes.filter(([,options])=>names.has(options.name)).map(([keys,options])=>({collection,keys,options})));
if (!process.argv.includes('--apply')) console.log(JSON.stringify({mode:'read-only-plan',indexes:selected},null,2));
else {
  const config=mongoConnectionOptions(),client=new MongoClient(config.uri,config.options);
  try {await client.connect();const db=client.db(config.dbName);for(const row of selected){await db.collection(row.collection).createIndex(row.keys,row.options);console.log(row.options.name);}}
  finally {await client.close();}
}
