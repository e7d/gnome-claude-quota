import assert from 'node:assert/strict';
import {test} from 'node:test';

import {shortenEmail} from '../lib/ellipsis.js';

const within = limit => text => text.length <= limit;

test('an address that fits is left alone', () => {
    assert.equal(shortenEmail('jane.doe@example.org', within(20)), 'jane.doe@example.org');
    assert.equal(shortenEmail('jane.doe@example.org', within(99)), 'jane.doe@example.org');
});

test('the name is cut and the domain kept whole when that is enough', () => {
    const email = 'an.extraordinarily.long.name@organisation.org';
    assert.equal(shortenEmail(email, within(33)), 'an.extraordinar…@organisation.org');
});

test('the name keeps as many characters as fit', () => {
    const email = 'abcdefghij@example.org';
    assert.equal(shortenEmail(email, within(21)), 'abcdefgh…@example.org');
    assert.equal(shortenEmail(email, within(20)), 'abcdefg…@example.org');
});

test('the name keeps three characters at least', () => {
    const email = 'brother.of.nobody@example.org';
    assert.equal(shortenEmail(email, within(18)), 'broth…@example.org');
    assert.equal(shortenEmail(email, within(16)), 'bro…@example.org');
});

test('a domain too long for three name characters is cut from its start', () => {
    const email = 'brother@subdomain.areallylongdomain.tld';
    assert.equal(shortenEmail(email, within(27)), 'bro…@…areallylongdomain.tld');
});

test('the domain keeps as many trailing characters as fit', () => {
    const email = 'brother@subdomain.areallylongdomain.tld';
    assert.equal(shortenEmail(email, within(26)), 'bro…@…reallylongdomain.tld');
    assert.equal(shortenEmail(email, within(12)), 'bro…@…in.tld');
});

test('a name of three characters or fewer is not given an ellipsis of its own', () => {
    assert.equal(shortenEmail('bro@subdomain.areallylongdomain.tld', within(26)), 'bro@…areallylongdomain.tld');
    assert.equal(shortenEmail('al@subdomain.areallylongdomain.tld', within(20)), 'al@…lylongdomain.tld');
});

test('nothing fitting yields the shortest form rather than nothing', () => {
    assert.equal(shortenEmail('brother@example.org', () => false), 'bro…@…g');
});

test('an address with no usable name is returned as it is', () => {
    assert.equal(shortenEmail('@example.org', within(3)), '@example.org');
    assert.equal(shortenEmail('no-at-sign-here', within(3)), 'no-at-sign-here');
});

test('the last at-sign splits the name from the domain', () => {
    assert.equal(shortenEmail('a.b@c@example.org', within(16)), 'a.b…@example.org');
});
