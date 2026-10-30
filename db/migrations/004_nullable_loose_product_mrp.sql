-- Loose products have a per-unit price (for example ₹62/kg) but no reference
-- MRP. Keep packed-product MRP required while allowing NULL for loose products.
ALTER TABLE products ALTER COLUMN mrp DROP NOT NULL;
ALTER TABLE products DROP CONSTRAINT products_check;
ALTER TABLE products
  ADD CONSTRAINT products_mrp_check CHECK (mrp IS NULL OR mrp >= price);
ALTER TABLE products
  ADD CONSTRAINT products_mrp_required_for_non_loose
  CHECK (mrp IS NOT NULL OR data->>'saleType' = 'loose');
