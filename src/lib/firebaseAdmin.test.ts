import test from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import { requireRoles } from './firebaseAdmin.ts';

test('Firebase API role guard rejects missing and customer roles', () => {
  const guard = requireRoles('BUSINESS_OWNER');
  let statusCode = 0;
  let responseBody: unknown;
  let nextCalled = false;
  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      responseBody = body;
      return this;
    },
  } as Response;

  guard({} as Request, response, (() => { nextCalled = true; }) as NextFunction);
  assert.equal(statusCode, 403);
  assert.deepEqual(responseBody, {
    error: 'You do not have permission to perform this action.',
  });
  assert.equal(nextCalled, false);

  guard(
    { authUser: { role: 'CUSTOMER' } } as Request,
    response,
    (() => { nextCalled = true; }) as NextFunction
  );
  assert.equal(statusCode, 403);
  assert.equal(nextCalled, false);
});

test('Firebase API role guard accepts an authorized server-side role', () => {
  const guard = requireRoles('BUSINESS_OWNER');
  let nextCalled = false;
  let statusCode = 0;
  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json() {
      return this;
    },
  } as Response;

  guard(
    { authUser: { role: 'BUSINESS_OWNER' } } as Request,
    response,
    (() => { nextCalled = true; }) as NextFunction
  );
  assert.equal(statusCode, 0);
  assert.equal(nextCalled, true);
});
