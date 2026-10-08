import test from 'node:test';import assert from 'node:assert/strict';import {canonicalJson} from './json-equal.js';
test('replay comparison ignores object key order but checks all values and array order',()=>{
 assert.equal(canonicalJson({id:'a',nested:{qty:1,user:'b'}}),canonicalJson({nested:{user:'b',qty:1},id:'a'}));
 assert.notEqual(canonicalJson({qty:1}),canonicalJson({qty:2}));assert.notEqual(canonicalJson([1,2]),canonicalJson([2,1]));assert.notEqual(canonicalJson({qty:1}),canonicalJson({qty:'1'}));
});
