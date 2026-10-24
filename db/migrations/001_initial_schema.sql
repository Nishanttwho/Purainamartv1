CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_users (
  id text PRIMARY KEY,
  position integer NOT NULL DEFAULT 0,
  phone text UNIQUE,
  email text UNIQUE,
  referral_code text UNIQUE,
  data jsonb NOT NULL
);
CREATE TABLE categories (id text PRIMARY KEY, position integer NOT NULL DEFAULT 0, data jsonb NOT NULL);
CREATE TABLE riders (id text PRIMARY KEY, position integer NOT NULL DEFAULT 0, phone text UNIQUE, is_active boolean NOT NULL DEFAULT true, data jsonb NOT NULL);
CREATE TABLE delivery_areas (id text PRIMARY KEY, position integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true, delivery_charge numeric(12,2) NOT NULL CHECK (delivery_charge >= 0), minimum_order numeric(12,2) NOT NULL CHECK (minimum_order >= 0), free_delivery_threshold numeric(12,2) CHECK (free_delivery_threshold IS NULL OR free_delivery_threshold >= 0), data jsonb NOT NULL);
CREATE TABLE products (
  id text PRIMARY KEY,
  position integer NOT NULL DEFAULT 0,
  category_id text NOT NULL REFERENCES categories(id) DEFERRABLE INITIALLY DEFERRED,
  name text NOT NULL,
  price numeric(12,2) NOT NULL CHECK (price >= 0),
  mrp numeric(12,2) NOT NULL CHECK (mrp >= price),
  stock integer NOT NULL CHECK (stock >= 0),
  is_active boolean NOT NULL DEFAULT true,
  rank integer NOT NULL DEFAULT 0,
  data jsonb NOT NULL
);
CREATE TABLE coupons (
  code text PRIMARY KEY,
  minimum numeric(12,2) NOT NULL CHECK (minimum >= 0),
  discount numeric(12,2) NOT NULL CHECK (discount >= 0),
  maximum_discount numeric(12,2) CHECK (maximum_discount IS NULL OR maximum_discount >= 0),
  redemption_count integer NOT NULL DEFAULT 0 CHECK (redemption_count >= 0),
  discount_type text NOT NULL CHECK (discount_type IN ('fixed','percentage')),
  is_active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  data jsonb NOT NULL
);
CREATE TABLE customer_addresses (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  position integer NOT NULL DEFAULT 0,
  delivery_area_id text,
  data jsonb NOT NULL,
  UNIQUE (user_id, id)
);
CREATE TABLE cart_items (owner_id text NOT NULL, product_id text NOT NULL REFERENCES products(id) DEFERRABLE INITIALLY DEFERRED, quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10), PRIMARY KEY(owner_id,product_id));
CREATE TABLE wishlist_items (owner_id text NOT NULL, product_id text NOT NULL REFERENCES products(id) DEFERRABLE INITIALLY DEFERRED, PRIMARY KEY(owner_id,product_id));
CREATE TABLE applied_coupons (owner_id text PRIMARY KEY, coupon_code text, data jsonb NOT NULL);
CREATE TABLE orders (
  id text PRIMARY KEY,
  position integer NOT NULL DEFAULT 0,
  display_id text NOT NULL,
  user_id text NOT NULL REFERENCES app_users(id) DEFERRABLE INITIALLY DEFERRED,
  rider_id text REFERENCES riders(id) DEFERRABLE INITIALLY DEFERRED,
  delivery_area_id text,
  idempotency_key text,
  status text NOT NULL,
  payment_method text NOT NULL,
  payment_status text NOT NULL,
  subtotal numeric(12,2) NOT NULL CHECK (subtotal >= 0),
  discount numeric(12,2) NOT NULL CHECK (discount >= 0),
  delivery numeric(12,2) NOT NULL CHECK (delivery >= 0),
  platform numeric(12,2) NOT NULL CHECK (platform >= 0),
  total numeric(12,2) NOT NULL CHECK (total >= 0),
  created_at timestamptz NOT NULL,
  data jsonb NOT NULL
);
CREATE TABLE app_sessions (
  id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('customer','rider','admin')),
  owner_id text,
  expires_at bigint,
  data jsonb NOT NULL,
  PRIMARY KEY (kind,id)
);
CREATE TABLE auth_challenges (
  id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('customer','rider','admin')),
  data jsonb NOT NULL,
  PRIMARY KEY (kind,id)
);
CREATE TABLE notifications (id text PRIMARY KEY, user_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED, position integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL, data jsonb NOT NULL);
CREATE TABLE notification_settings (user_id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE referrals (
  id text PRIMARY KEY,
  position integer NOT NULL DEFAULT 0,
  referrer_user_id text NOT NULL REFERENCES app_users(id) DEFERRABLE INITIALLY DEFERRED,
  referred_user_id text NOT NULL UNIQUE REFERENCES app_users(id) DEFERRABLE INITIALLY DEFERRED,
  qualifying_order_id text REFERENCES orders(id) DEFERRABLE INITIALLY DEFERRED,
  reward_id text,
  status text NOT NULL,
  data jsonb NOT NULL
);
CREATE TABLE rewards (
  id text PRIMARY KEY,
  position integer NOT NULL DEFAULT 0,
  user_id text NOT NULL REFERENCES app_users(id) DEFERRABLE INITIALLY DEFERRED,
  qualifying_order_id text REFERENCES orders(id) DEFERRABLE INITIALLY DEFERRED,
  order_id text REFERENCES orders(id) DEFERRABLE INITIALLY DEFERRED,
  status text NOT NULL,
  data jsonb NOT NULL
);
CREATE UNIQUE INDEX rewards_qualifying_order_unique_idx ON rewards(qualifying_order_id) WHERE qualifying_order_id IS NOT NULL;
ALTER TABLE referrals ADD CONSTRAINT referrals_reward_fk FOREIGN KEY (reward_id) REFERENCES rewards(id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE referral_events (id text PRIMARY KEY, position integer NOT NULL DEFAULT 0, user_id text REFERENCES app_users(id) DEFERRABLE INITIALLY DEFERRED, created_at timestamptz, data jsonb NOT NULL);
CREATE TABLE selected_delivery (owner_id text PRIMARY KEY, area_id text, address_id text);
CREATE TABLE application_settings (key text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE order_payments (
  order_id text PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  method text NOT NULL,
  status text NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  transaction_reference text,
  data jsonb NOT NULL
);

CREATE INDEX products_category_active_rank_idx ON products(category_id,is_active,rank);
CREATE INDEX products_name_search_idx ON products USING gin (to_tsvector('simple', name));
CREATE UNIQUE INDEX orders_customer_idempotency_idx ON orders(user_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX orders_customer_created_idx ON orders(user_id,created_at DESC);
CREATE INDEX orders_rider_status_idx ON orders(rider_id,status);
CREATE INDEX orders_dispatch_idx ON orders(status,created_at) WHERE rider_id IS NULL;
CREATE INDEX orders_payment_status_idx ON orders(payment_status);
CREATE INDEX delivery_areas_active_idx ON delivery_areas(is_active);
CREATE INDEX sessions_expiry_idx ON app_sessions(expires_at);
CREATE INDEX addresses_user_idx ON customer_addresses(user_id);
CREATE INDEX notifications_user_created_idx ON notifications(user_id,created_at DESC);
CREATE INDEX referrals_referrer_status_idx ON referrals(referrer_user_id,status);
CREATE INDEX rewards_user_status_idx ON rewards(user_id,status);

CREATE OR REPLACE FUNCTION store_snapshot()
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    '__initialized', EXISTS(SELECT 1 FROM application_settings) OR EXISTS(SELECT 1 FROM app_users) OR EXISTS(SELECT 1 FROM categories) OR EXISTS(SELECT 1 FROM products),
    'users', COALESCE((SELECT jsonb_agg(data ORDER BY position) FROM app_users), '[]'::jsonb),
    'categories', COALESCE((SELECT jsonb_agg(data ORDER BY position) FROM categories), '[]'::jsonb),
    'riders', COALESCE((SELECT jsonb_agg(data ORDER BY position) FROM riders), '[]'::jsonb),
    'deliveryAreas', COALESCE((SELECT jsonb_agg(data ORDER BY position) FROM delivery_areas), '[]'::jsonb),
    'products', COALESCE((SELECT jsonb_agg(data ORDER BY position) FROM products), '[]'::jsonb),
    'coupons', COALESCE((SELECT jsonb_object_agg(code,data) FROM coupons), '{}'::jsonb),
    'addresses', COALESCE((SELECT jsonb_object_agg(user_id,items) FROM (SELECT user_id,jsonb_agg(data ORDER BY position) AS items FROM customer_addresses GROUP BY user_id) a), '{}'::jsonb),
    'carts', COALESCE((SELECT jsonb_object_agg(owner_id,items) FROM (SELECT owner_id,jsonb_object_agg(product_id,quantity) AS items FROM cart_items GROUP BY owner_id) c), '{}'::jsonb),
    'wishlists', COALESCE((SELECT jsonb_object_agg(owner_id,items) FROM (SELECT owner_id,jsonb_agg(product_id) AS items FROM wishlist_items GROUP BY owner_id) w), '{}'::jsonb),
    'appliedCoupon', COALESCE((SELECT jsonb_object_agg(owner_id,data) FROM applied_coupons), '{}'::jsonb),
    'orders', COALESCE((SELECT jsonb_agg(data ORDER BY position) FROM orders), '[]'::jsonb),
    'sessions', COALESCE((SELECT jsonb_object_agg(id,data) FROM app_sessions WHERE kind='customer'), '{}'::jsonb),
    'riderSessions', COALESCE((SELECT jsonb_object_agg(id,data) FROM app_sessions WHERE kind='rider'), '{}'::jsonb),
    'adminSessions', COALESCE((SELECT jsonb_object_agg(id,data) FROM app_sessions WHERE kind='admin'), '{}'::jsonb),
    'challenges', COALESCE((SELECT jsonb_object_agg(id,data) FROM auth_challenges WHERE kind='customer'), '{}'::jsonb),
    'riderChallenges', COALESCE((SELECT jsonb_object_agg(id,data) FROM auth_challenges WHERE kind='rider'), '{}'::jsonb),
    'adminChallenges', COALESCE((SELECT jsonb_object_agg(id,data) FROM auth_challenges WHERE kind='admin'), '{}'::jsonb),
    'notifications', COALESCE((SELECT jsonb_object_agg(user_id,items) FROM (SELECT user_id,jsonb_agg(data ORDER BY position) AS items FROM notifications GROUP BY user_id) n), '{}'::jsonb),
    'notificationWelcome', COALESCE((SELECT jsonb_object_agg(user_id,data) FROM notification_settings), '{}'::jsonb),
    'referrals', COALESCE((SELECT jsonb_agg(data ORDER BY position) FROM referrals), '[]'::jsonb),
    'rewards', COALESCE((SELECT jsonb_agg(data ORDER BY position) FROM rewards), '[]'::jsonb),
    'referralEvents', COALESCE((SELECT jsonb_agg(data ORDER BY position) FROM referral_events), '[]'::jsonb),
    'selectedDeliveryAreas', COALESCE((SELECT jsonb_object_agg(owner_id,area_id) FROM selected_delivery WHERE area_id IS NOT NULL), '{}'::jsonb),
    'selectedDeliveryAddresses', COALESCE((SELECT jsonb_object_agg(owner_id,address_id) FROM selected_delivery WHERE address_id IS NOT NULL), '{}'::jsonb),
    'referralCampaign', COALESCE((SELECT data FROM application_settings WHERE key='referralCampaign'), '{}'::jsonb),
    'dispatchSettings', COALESCE((SELECT data FROM application_settings WHERE key='dispatchSettings'), '{"designatedRiderId":null}'::jsonb)
  );
$$;

CREATE OR REPLACE FUNCTION write_store_snapshot(p_state jsonb, p_replace boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_replace THEN
    TRUNCATE app_users,categories,riders,delivery_areas,products,coupons,customer_addresses,cart_items,wishlist_items,applied_coupons,orders,order_payments,app_sessions,auth_challenges,notifications,notification_settings,referrals,rewards,referral_events,selected_delivery,application_settings;
  END IF;
  INSERT INTO app_users(id,position,phone,email,referral_code,data)
    SELECT d->>'id',ord::integer,NULLIF(d->>'phone',''),NULLIF(lower(d->>'email'),''),NULLIF(d->>'referralCode',''),d FROM jsonb_array_elements(COALESCE(p_state->'users','[]')) WITH ORDINALITY t(d,ord)
    ON CONFLICT(id) DO UPDATE SET position=excluded.position,phone=excluded.phone,email=excluded.email,referral_code=excluded.referral_code,data=excluded.data;
  INSERT INTO categories(id,position,data) SELECT d->>'id',ord::integer,d FROM jsonb_array_elements(COALESCE(p_state->'categories','[]')) WITH ORDINALITY t(d,ord) ON CONFLICT(id) DO UPDATE SET position=excluded.position,data=excluded.data;
  INSERT INTO riders(id,position,phone,is_active,data) SELECT d->>'id',ord::integer,NULLIF(d->>'phone',''),COALESCE((d->>'isActive')::boolean,true),d FROM jsonb_array_elements(COALESCE(p_state->'riders','[]')) WITH ORDINALITY t(d,ord) ON CONFLICT(id) DO UPDATE SET position=excluded.position,phone=excluded.phone,is_active=excluded.is_active,data=excluded.data;
  INSERT INTO delivery_areas(id,position,is_active,delivery_charge,minimum_order,free_delivery_threshold,data)
    SELECT d->>'id',ord::integer,COALESCE((d->>'isActive')::boolean,true),COALESCE(NULLIF(d->>'deliveryCharge','')::numeric,0),COALESCE(NULLIF(d->>'minimumOrder','')::numeric,0),NULLIF(d->>'freeDeliveryThreshold','')::numeric,d FROM jsonb_array_elements(COALESCE(p_state->'deliveryAreas','[]')) WITH ORDINALITY t(d,ord)
    ON CONFLICT(id) DO UPDATE SET position=excluded.position,is_active=excluded.is_active,delivery_charge=excluded.delivery_charge,minimum_order=excluded.minimum_order,free_delivery_threshold=excluded.free_delivery_threshold,data=excluded.data;
  INSERT INTO products(id,position,category_id,name,price,mrp,stock,is_active,rank,data)
    SELECT d->>'id',ord::integer,d->>'category',d->>'name',(d->>'price')::numeric,(d->>'mrp')::numeric,(d->>'stock')::integer,COALESCE((d->>'isActive')::boolean,true),COALESCE((d->>'rank')::integer,0),d FROM jsonb_array_elements(COALESCE(p_state->'products','[]')) WITH ORDINALITY t(d,ord)
    ON CONFLICT(id) DO UPDATE SET position=excluded.position,category_id=excluded.category_id,name=excluded.name,price=excluded.price,mrp=excluded.mrp,stock=excluded.stock,is_active=excluded.is_active,rank=excluded.rank,data=excluded.data;
  INSERT INTO coupons(code,minimum,discount,discount_type,maximum_discount,redemption_count,is_active,expires_at,data)
    SELECT COALESCE(d->>'code',e.key),COALESCE(NULLIF(d->>'minimum','')::numeric,0),COALESCE(NULLIF(d->>'discount','')::numeric,0),COALESCE(d->>'discountType','fixed'),NULLIF(d->>'maximumDiscount','')::numeric,COALESCE(NULLIF(d->>'redemptionCount','')::integer,0),COALESCE((d->>'isActive')::boolean,true),NULLIF(d->>'expiresAt','')::timestamptz,d FROM jsonb_each(COALESCE(p_state->'coupons','{}')) e(key,d)
    ON CONFLICT(code) DO UPDATE SET minimum=excluded.minimum,discount=excluded.discount,discount_type=excluded.discount_type,maximum_discount=excluded.maximum_discount,redemption_count=excluded.redemption_count,is_active=excluded.is_active,expires_at=excluded.expires_at,data=excluded.data;
  INSERT INTO customer_addresses(id,user_id,position,delivery_area_id,data)
    SELECT a->>'id',u.key,ord::integer,a->>'deliveryAreaId',a FROM jsonb_each(COALESCE(p_state->'addresses','{}')) u(key,items) CROSS JOIN LATERAL jsonb_array_elements(u.items) WITH ORDINALITY addresses(a,ord)
    ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,position=excluded.position,delivery_area_id=excluded.delivery_area_id,data=excluded.data;
  INSERT INTO cart_items(owner_id,product_id,quantity)
    SELECT c.key,i.key,(i.value#>>'{}')::integer FROM jsonb_each(COALESCE(p_state->'carts','{}')) c(key,items) CROSS JOIN LATERAL jsonb_each(c.items) i(key,value)
    ON CONFLICT(owner_id,product_id) DO UPDATE SET quantity=excluded.quantity;
  INSERT INTO wishlist_items(owner_id,product_id)
    SELECT w.key,i.value#>>'{}' FROM jsonb_each(COALESCE(p_state->'wishlists','{}')) w(key,items) CROSS JOIN LATERAL jsonb_array_elements(w.items) i(value)
    ON CONFLICT(owner_id,product_id) DO NOTHING;
  INSERT INTO applied_coupons(owner_id,coupon_code,data) SELECT key,CASE WHEN jsonb_typeof(value)='string' THEN value#>>'{}' ELSE NULL END,value FROM jsonb_each(COALESCE(p_state->'appliedCoupon','{}')) ON CONFLICT(owner_id) DO UPDATE SET coupon_code=excluded.coupon_code,data=excluded.data;
  INSERT INTO orders(id,position,display_id,user_id,rider_id,delivery_area_id,idempotency_key,status,payment_method,payment_status,subtotal,discount,delivery,platform,total,created_at,data)
    SELECT d->>'id',ord::integer,COALESCE(d->>'displayId',d->>'id'),d->>'userId',NULLIF(d->>'riderId',''),d#>>'{deliveryArea,id}',NULLIF(d->>'idempotencyKey',''),COALESCE(d->>'status','Order received'),COALESCE(d->>'paymentMethod','Cash on delivery'),COALESCE(d->>'paymentStatus','Pending'),COALESCE(NULLIF(d->>'subtotal','')::numeric,0),COALESCE(NULLIF(d->>'discount','')::numeric,0),COALESCE(NULLIF(d->>'delivery','')::numeric,0),COALESCE(NULLIF(d->>'platform','')::numeric,0),COALESCE(NULLIF(d->>'total','')::numeric,0),COALESCE(NULLIF(d->>'createdAt','')::timestamptz,now()),d FROM jsonb_array_elements(COALESCE(p_state->'orders','[]')) WITH ORDINALITY t(d,ord)
    ON CONFLICT(id) DO UPDATE SET position=excluded.position,display_id=excluded.display_id,user_id=excluded.user_id,rider_id=excluded.rider_id,delivery_area_id=excluded.delivery_area_id,idempotency_key=excluded.idempotency_key,status=excluded.status,payment_method=excluded.payment_method,payment_status=excluded.payment_status,subtotal=excluded.subtotal,discount=excluded.discount,delivery=excluded.delivery,platform=excluded.platform,total=excluded.total,created_at=excluded.created_at,data=excluded.data;
  INSERT INTO order_payments(order_id,method,status,amount,transaction_reference,data)
    SELECT d->>'id',COALESCE(d->>'paymentMethod','Cash on delivery'),COALESCE(d->>'paymentStatus','Pending'),COALESCE(NULLIF(d->>'total','')::numeric,0),d#>>'{paymentVerification,transactionReference}',jsonb_build_object('verification',d->'paymentVerification','collection',d->'paymentCollection','reconciliation',d->'paymentReconciliation')
    FROM jsonb_array_elements(COALESCE(p_state->'orders','[]')) d
    ON CONFLICT(order_id) DO UPDATE SET method=excluded.method,status=excluded.status,amount=excluded.amount,transaction_reference=excluded.transaction_reference,data=excluded.data;
  INSERT INTO app_sessions(id,kind,owner_id,expires_at,data)
    SELECT e.key,'customer',e.value->>'userId',NULLIF(e.value->>'expiresAt','')::bigint,e.value FROM jsonb_each(COALESCE(p_state->'sessions','{}')) e
    UNION ALL SELECT e.key,'rider',e.value->>'riderId',NULLIF(e.value->>'expiresAt','')::bigint,e.value FROM jsonb_each(COALESCE(p_state->'riderSessions','{}')) e
    UNION ALL SELECT e.key,'admin',e.value->>'adminId',NULLIF(e.value->>'expiresAt','')::bigint,e.value FROM jsonb_each(COALESCE(p_state->'adminSessions','{}')) e
    ON CONFLICT(kind,id) DO UPDATE SET owner_id=excluded.owner_id,expires_at=excluded.expires_at,data=excluded.data;
  INSERT INTO auth_challenges(id,kind,data)
    SELECT e.key,'customer',e.value FROM jsonb_each(COALESCE(p_state->'challenges','{}')) e
    UNION ALL SELECT e.key,'rider',e.value FROM jsonb_each(COALESCE(p_state->'riderChallenges','{}')) e
    UNION ALL SELECT e.key,'admin',e.value FROM jsonb_each(COALESCE(p_state->'adminChallenges','{}')) e
    ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data;
  INSERT INTO notifications(id,user_id,position,created_at,data)
    SELECT n->>'id',u.key,ord::integer,COALESCE(NULLIF(n->>'createdAt','')::timestamptz,now()),n FROM jsonb_each(COALESCE(p_state->'notifications','{}')) u(key,items) CROSS JOIN LATERAL jsonb_array_elements(u.items) WITH ORDINALITY notices(n,ord)
    ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,position=excluded.position,created_at=excluded.created_at,data=excluded.data;
  INSERT INTO notification_settings(user_id,data) SELECT key,value FROM jsonb_each(COALESCE(p_state->'notificationWelcome','{}')) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data;
  INSERT INTO referrals(id,position,referrer_user_id,referred_user_id,qualifying_order_id,reward_id,status,data)
    SELECT d->>'id',ord::integer,d->>'referrerUserId',d->>'referredUserId',NULLIF(d->>'qualifyingOrderId',''),NULLIF(d->>'rewardId',''),COALESCE(d->>'status','pending'),d FROM jsonb_array_elements(COALESCE(p_state->'referrals','[]')) WITH ORDINALITY t(d,ord)
    ON CONFLICT(id) DO UPDATE SET position=excluded.position,referrer_user_id=excluded.referrer_user_id,referred_user_id=excluded.referred_user_id,qualifying_order_id=excluded.qualifying_order_id,reward_id=excluded.reward_id,status=excluded.status,data=excluded.data;
  INSERT INTO rewards(id,position,user_id,qualifying_order_id,order_id,status,data)
    SELECT d->>'id',ord::integer,d->>'userId',NULLIF(d->>'qualifyingOrderId',''),NULLIF(d->>'orderId',''),COALESCE(d->>'status','available'),d FROM jsonb_array_elements(COALESCE(p_state->'rewards','[]')) WITH ORDINALITY t(d,ord)
    ON CONFLICT(id) DO UPDATE SET position=excluded.position,user_id=excluded.user_id,qualifying_order_id=excluded.qualifying_order_id,order_id=excluded.order_id,status=excluded.status,data=excluded.data;
  INSERT INTO referral_events(id,position,user_id,created_at,data)
    SELECT d->>'id',ord::integer,NULLIF(d->>'userId',''),NULLIF(d->>'at','')::timestamptz,d FROM jsonb_array_elements(COALESCE(p_state->'referralEvents','[]')) WITH ORDINALITY t(d,ord)
    ON CONFLICT(id) DO UPDATE SET position=excluded.position,user_id=excluded.user_id,created_at=excluded.created_at,data=excluded.data;
  INSERT INTO selected_delivery(owner_id,area_id,address_id)
    SELECT COALESCE(e.key,d.key),e.value#>>'{}',d.value#>>'{}'
    FROM jsonb_each(COALESCE(p_state->'selectedDeliveryAreas','{}')) e
    FULL JOIN jsonb_each(COALESCE(p_state->'selectedDeliveryAddresses','{}')) d ON e.key=d.key
    ON CONFLICT(owner_id) DO UPDATE SET area_id=excluded.area_id,address_id=excluded.address_id;
  INSERT INTO application_settings(key,data) VALUES ('referralCampaign',COALESCE(p_state->'referralCampaign','{}')),('dispatchSettings',COALESCE(p_state->'dispatchSettings','{"designatedRiderId":null}'))
    ON CONFLICT(key) DO UPDATE SET data=excluded.data;
END;
$$;
