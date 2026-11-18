import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moveToTrash, restoreOrder } from '../trash.js';

const makeOrder = names => [...names].map(id => ({ id }));
const orderOf = entries => entries.map(entry => entry.id).join('');

test('restores adjacent images in either order after separate deletions', () => {
  for (const removed of ['bc', 'cb']) {
    let order = makeOrder('abcd'), trash = [];
    for (const id of removed) ({ order, trash } = moveToTrash(order, trash, [id]));
    for (const sequence of ['bc', 'cb']) {
      let active = order, deleted = trash;
      for (const id of sequence) {
        active = restoreOrder(active, deleted, [id]);
        deleted = deleted.filter(record => record.entry.id !== id);
      }
      assert.equal(orderOf(active), 'abcd');
    }
    assert.equal(orderOf(restoreOrder(order, trash, removed)), 'abcd');
  }
});

test('persistent neighbours give insertion points after other entries move', () => {
  const { trash } = moveToTrash(makeOrder('abcde'), [], ['b', 'c']);
  assert.equal(orderOf(restoreOrder(makeOrder('eadx'), trash, ['b', 'c'])), 'eabcdx');
  assert.equal(orderOf(restoreOrder(makeOrder('xda'), trash, ['b', 'c'])), 'xbcda');
  assert.equal(orderOf(restoreOrder(makeOrder('dx'), trash, ['c'])), 'cdx');
  assert.equal(orderOf(restoreOrder(makeOrder('xyz'), trash, ['b', 'c'])), 'xbcyz');
});

test('restoring all keeps relative order even when positions must be clamped', () => {
  const { trash } = moveToTrash(makeOrder('abcdef'), [], ['d', 'e', 'f']);
  assert.equal(orderOf(restoreOrder(makeOrder('x'), trash, ['f', 'd', 'e'])), 'xdef');
  const mixed = moveToTrash(makeOrder('abcd'), [], ['b']);
  const all = moveToTrash(mixed.order, mixed.trash, ['a', 'c', 'd']);
  assert.equal(orderOf(restoreOrder(all.order, all.trash, orderOf(makeOrder('abcd')))), 'abcd');
});
