import test from 'node:test';
import assert from 'node:assert/strict';
import { fromMoneyCents, toMoneyCents, validatePricingVariants } from '../lib/product-pricing.mjs';
test('money validation uses integer cents and requires configured reference prices to cover the sale price',()=>{
  assert.equal(toMoneyCents(34.25),3425);assert.equal(fromMoneyCents(3425),34.25);assert.equal(toMoneyCents(-1),null);
  const good=validatePricingVariants('loose','ml',[{id:'v500',label:'500 ml',quantityBase:500,price:34,mrp:42,stock:1000},{id:'v1l',label:'1 litre',quantityBase:1000,price:64,mrp:null,stock:1000}]);
  assert.equal(good.error,undefined);assert.equal(good.variants[1].mrp,null);
  assert.match(validatePricingVariants('packed','g',[{label:'1 kg',quantityBase:1000,price:120,mrp:100,stock:2}]).error,/cannot exceed/);
  assert.match(validatePricingVariants('loose','piece',[{label:'one',quantityBase:1,price:1,stock:1}]).error,/measurement unit/);
  assert.match(validatePricingVariants('loose','g',[{label:'500 g',quantityBase:500,price:1,stock:2.5}]).error,/whole number/);
});
