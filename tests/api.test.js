import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const projectRoot = path.resolve(import.meta.dirname, '..');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Find an available local port for the isolated API test server. */
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('tenant isolation, catalog management, public ordering and status lifecycle', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'cafeyar-test-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), DATABASE_PATH: path.join(temp, 'db.sqlite'), UPLOAD_DIR: path.join(temp, 'uploads') },
    stdio: 'ignore'
  });
  /** Send a request to the test server and return its response and session cookie. */
  async function request(url, method = 'GET', body, cookie) {
    const response = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const result = await response.json();
    return { status: response.status, result, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (server.exitCode !== null) throw new Error('Server exited before ready');
      try { healthy = (await request('/api/health')).status === 200; if (healthy) break; } catch { await delay(100); }
    }
    assert.equal(healthy, true, 'server should become healthy');

    const demoLogin = await request('/api/auth/demo', 'POST', {});
    assert.equal(demoLogin.status, 200);
    const demoCookie = demoLogin.cookie;
    const demo = await request('/api/admin/bootstrap', 'GET', null, demoCookie);
    assert.equal(demo.result.cafe.slug, 'cafe-dali');
    assert.ok(demo.result.products.length >= 8);

    const registration = await request('/api/auth/register', 'POST', { name: 'مدیر', cafeName: 'کافه تست', slug: 'test-cafe', email: 'owner@example.com', password: 'strongpassword' });
    assert.equal(registration.status, 201);
    const ownerCookie = registration.cookie;
    const newCafe = await request('/api/admin/bootstrap', 'GET', null, ownerCookie);
    assert.equal(newCafe.result.cafe.slug, 'test-cafe');
    assert.equal(newCafe.result.products.length, 0);
    assert.equal((await request('/api/admin/products/' + demo.result.products[0].id, 'DELETE', null, ownerCookie)).status, 404);
    assert.equal((await request('/api/admin/orders/' + demo.result.orders[0].id, 'PATCH', { status: 'completed' }, ownerCookie)).status, 404);
    assert.equal((await request('/api/admin/cafe', 'PATCH', { slug: 'cafe-dali' }, ownerCookie)).status, 409);
    assert.equal((await request('/api/admin/cafe', 'PATCH', { slug: 'invalid slug' }, ownerCookie)).status, 400);
    assert.equal((await request('/api/admin/cafe', 'PATCH', { slug: 'test-cafe-new' }, ownerCookie)).status, 200);
    assert.equal((await request('/api/public/test-cafe')).status, 404);
    assert.equal((await request('/api/public/test-cafe-new')).status, 200);
    assert.equal((await request('/api/admin/cafe', 'PATCH', { slug: 'test-cafe' }, ownerCookie)).status, 200);

    const form = new FormData();
    form.append('image', new Blob([readFileSync(path.join(projectRoot, 'public/assets/latte.jpg'))], { type: 'image/jpeg' }), 'latte.jpg');
    const uploadedResponse = await fetch(base + '/api/admin/upload', { method: 'POST', headers: { Cookie: ownerCookie }, body: form });
    const uploaded = await uploadedResponse.json();
    assert.equal(uploadedResponse.status, 201);
    assert.match(uploaded.url, /^\/uploads\/[\w-]+\.jpg$/);
    assert.equal((await fetch(base + uploaded.url)).status, 200);
    assert.equal((await request('/api/admin/gallery', 'POST', { image_url: uploaded.url }, ownerCookie)).status, 201);
    assert.equal((await request('/api/admin/bootstrap', 'GET', null, ownerCookie)).result.gallery.length, 1);
    assert.equal((await request('/api/admin/ai/context', 'GET', null, demoCookie)).result.products.some(item => item.name === 'چای سبز'), false);

    const categoryId = newCafe.result.categories[0].id;
    assert.equal((await request('/api/admin/products', 'POST', { name: 'محصول نامعتبر', price: 1, category_id: demo.result.categories[0].id }, ownerCookie)).status, 400);
    assert.equal((await request('/api/admin/products', 'POST', { name: 'محصول نامعتبر', price: 1, category_id: 'not-a-number' }, ownerCookie)).status, 400);
    const created = await request('/api/admin/products', 'POST', { name: 'چای سبز', description: 'چای تازه', category_id: categoryId, price: 85000, available: true }, ownerCookie);
    assert.equal(created.status, 201);
    const productId = created.result.id;
    const menu = await request('/api/public/test-cafe');
    assert.equal(menu.result.products.length, 1);
    assert.equal(menu.result.products[0].name, 'چای سبز');
    assert.equal((await request('/api/public/cafe-dali')).result.products.some(item => item.id === productId && item.name === 'چای سبز'), false);

    const invalidOrder = await request('/api/public/test-cafe/orders', 'POST', { customer_name: 'مشتری', customer_phone: '0912', items: [{ product_id: demo.result.products[0].id, quantity: 1 }] });
    assert.equal(invalidOrder.status, 400);
    assert.equal((await request('/api/public/test-cafe/orders', 'POST', { customer_name: 'مشتری', customer_phone: '0912', items: [null] })).status, 400);
    const order = await request('/api/public/test-cafe/orders', 'POST', { customer_name: 'مشتری تست', customer_phone: '09120000000', items: [{ product_id: productId, quantity: 2, price: 1 }] });
    assert.equal(order.status, 201);
    assert.equal(order.result.total, 170000, 'server computes price, ignoring client amount');
    const context = await request('/api/admin/ai/context', 'GET', null, ownerCookie);
    assert.equal(context.result.sales[0].name, 'چای سبز');
    assert.equal(context.result.sales[0].units, 2);
    assert.equal(context.result.cafe.name, 'کافه تست');
    assert.equal(JSON.stringify(context.result).includes('09120000000'), false, 'AI context has no customer PII');
    const afterOrder = await request('/api/admin/bootstrap', 'GET', null, ownerCookie);
    assert.equal(afterOrder.result.orders[0].id, order.result.id);
    assert.equal(afterOrder.result.orders[0].items[0].product_name, 'چای سبز');
    assert.equal((await request('/api/admin/orders/' + order.result.id, 'PATCH', { status: 'preparing' }, ownerCookie)).status, 200);
    assert.equal((await request('/api/admin/orders/' + order.result.id, 'PATCH', { status: 'ready' }, ownerCookie)).status, 200);
    assert.equal((await request('/api/admin/orders/' + order.result.id, 'PATCH', { status: 'completed' }, ownerCookie)).status, 200);
    assert.equal((await request('/api/admin/bootstrap', 'GET', null, ownerCookie)).result.orders[0].status, 'completed');
    assert.equal((await request('/api/admin/bootstrap', 'GET', null, demoCookie)).result.orders.some(item => item.id === order.result.id && item.customer_name === 'مشتری تست'), false);

    assert.equal((await request('/api/admin/products/' + productId, 'PATCH', { name: 'چای سبز', price: 85000, category_id: categoryId, available: false }, ownerCookie)).status, 200);
    assert.equal((await request('/api/public/test-cafe')).result.products.length, 0);
    assert.equal((await request('/api/admin/products/' + productId, 'DELETE', null, ownerCookie)).status, 200);
    assert.equal((await request('/api/admin/bootstrap', 'GET', null, ownerCookie)).result.orders[0].items[0].product_name, 'چای سبز', 'historical order snapshots survive product deletion');
    assert.equal((await request('/api/auth/logout', 'POST', {}, ownerCookie)).status, 200);
    assert.equal((await request('/api/admin/bootstrap', 'GET', null, ownerCookie)).status, 401);
  } finally {
    server.kill('SIGTERM');
    await new Promise(resolve => server.once('exit', resolve));
    rmSync(temp, { recursive: true, force: true });
  }
});
