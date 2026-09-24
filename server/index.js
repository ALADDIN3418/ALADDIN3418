import express from 'express';
import multer from 'multer';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const databasePath = process.env.DATABASE_PATH || path.join(root, 'data', 'cafeyar.sqlite');
const uploadDir = process.env.UPLOAD_DIR || path.join(root, 'uploads');
mkdirSync(path.dirname(databasePath), { recursive: true });
mkdirSync(uploadDir, { recursive: true });

const db = new DatabaseSync(databasePath);
db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS cafes (id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', hours TEXT NOT NULL DEFAULT '', instagram TEXT NOT NULL DEFAULT '', accent TEXT NOT NULL DEFAULT '#d9b98a', cover_url TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, cafe_id INTEGER NOT NULL REFERENCES cafes(id) ON DELETE CASCADE, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, cafe_id INTEGER NOT NULL REFERENCES cafes(id) ON DELETE CASCADE, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY, cafe_id INTEGER NOT NULL REFERENCES cafes(id) ON DELETE CASCADE, category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', price INTEGER NOT NULL CHECK(price >= 0), image_url TEXT NOT NULL DEFAULT '', available INTEGER NOT NULL DEFAULT 1, featured INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS gallery (id INTEGER PRIMARY KEY, cafe_id INTEGER NOT NULL REFERENCES cafes(id) ON DELETE CASCADE, image_url TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, cafe_id INTEGER NOT NULL REFERENCES cafes(id) ON DELETE CASCADE, customer_name TEXT NOT NULL, customer_phone TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'new', total INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS order_items (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, product_id INTEGER REFERENCES products(id) ON DELETE SET NULL, product_name TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_products_cafe ON products(cafe_id);
CREATE INDEX IF NOT EXISTS idx_orders_cafe ON orders(cafe_id, created_at);
CREATE INDEX IF NOT EXISTS idx_categories_cafe ON categories(cafe_id);`);

const hashPassword = (password, salt) => scryptSync(password, salt, 64).toString('hex');
class InputError extends Error {}
const value = (input, max = 250) => String(input ?? '').trim().slice(0, max);
const validImageUrl = (input) => {
  const url = value(input, 1500);
  if (!url) return '';
  if (url.startsWith('/uploads/') || url.startsWith('/assets/')) return url;
  try { if (new URL(url).protocol === 'https:') return url; }
  catch { throw new InputError('آدرس تصویر باید HTTPS یا تصویر آپلودشده باشد.'); }
  throw new InputError('آدرس تصویر باید HTTPS یا تصویر آپلودشده باشد.');
};
const row = (sql, ...params) => db.prepare(sql).get(...params);
const rows = (sql, ...params) => db.prepare(sql).all(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);

/** Populate the demo cafe with catalog, gallery, and sample orders once. */
function seedDemo() {
  if (row('SELECT id FROM cafes WHERE slug = ?', 'cafe-dali')) return;
  db.exec('BEGIN');
  try {
    const cafeId = Number(run('INSERT INTO cafes (slug,name,description,address,phone,hours,instagram,cover_url) VALUES (?,?,?,?,?,?,?,?)', 'cafe-dali', 'کافه دالی', 'یک فنجان آرامش، میان شلوغی شهر. قهوه‌های خوب و لحظه‌های بهتر.', 'تهران، خیابان ولیعصر، کوچه نسترن، پلاک ۱۲', '۰۲۱-۸۸۷۷۶۶۵۵', 'هر روز ۸:۰۰ تا ۲۳:۰۰', '@cafedali', '/assets/cafe-interior.jpg').lastInsertRowid);
    const salt = randomBytes(16).toString('hex');
    run('INSERT INTO users (cafe_id,email,password_hash,salt) VALUES (?,?,?,?)', cafeId, 'demo@cafeyar.ir', hashPassword('demo1234', salt), salt);
    const categoryIds = {};
    ['قهوه‌های گرم', 'نوشیدنی‌های سرد', 'کیک و دسر', 'صبحانه و میان‌وعده'].forEach((name, index) => { categoryIds[name] = Number(run('INSERT INTO categories (cafe_id,name,sort_order) VALUES (?,?,?)', cafeId, name, index).lastInsertRowid); });
    const products = [
      ['لاته', 'قهوه‌های گرم', 'اسپرسو، شیر بخار داده و کمی عشق', 195000, 'latte.jpg', 1],
      ['کاپوچینو', 'قهوه‌های گرم', 'اسپرسو، شیر و کف مخملی', 185000, 'cappuccino.jpg', 1],
      ['آمریکانو', 'قهوه‌های گرم', 'اسپرسو و آب داغ، ساده و اصیل', 155000, 'americano.jpg', 0],
      ['موکا', 'قهوه‌های گرم', 'شکلات، اسپرسو و شیر گرم', 210000, 'mocha.jpg', 0],
      ['آیس لاته', 'نوشیدنی‌های سرد', 'اسپرسوی تازه، شیر سرد و یخ', 205000, 'iced-latte.jpg', 0],
      ['چیزکیک', 'کیک و دسر', 'چیزکیک خانگی با سس توت‌فرنگی', 235000, 'cheesecake.jpg', 1],
      ['کروسان', 'صبحانه و میان‌وعده', 'تازه، لایه‌لایه و کره‌ای', 145000, 'croissant.jpg', 0],
      ['کیک شکلاتی', 'کیک و دسر', 'یک برش از خوشحالی شکلاتی', 195000, 'chocolate-cake.jpg', 0]
    ];
    products.forEach(([name, category, description, price, image, featured]) => run('INSERT INTO products (cafe_id,category_id,name,description,price,image_url,featured) VALUES (?,?,?,?,?,?,?)', cafeId, categoryIds[category], name, description, price, `/assets/${image}`, featured));
    ['cafe-interior.jpg', 'latte.jpg', 'croissant.jpg', 'cappuccino.jpg'].forEach(image => run('INSERT INTO gallery (cafe_id,image_url) VALUES (?,?)', cafeId, `/assets/${image}`));
    const sampleOrders = [
      ['مریم محمدی', '۰۹۱۲۱۲۳۴۵۶۷', 'new', [['لاته', 2, 195000], ['چیزکیک', 1, 235000]]],
      ['علی رضایی', '۰۹۱۲۱۱۱۱۱۱۱', 'preparing', [['آمریکانو', 1, 155000]]],
      ['سارا احمدی', '۰۹۱۲۲۲۲۲۲۲۲', 'ready', [['کاپوچینو', 2, 185000], ['کروسان', 1, 145000]]],
      ['امیر حسینی', '۰۹۱۲۳۳۳۳۳۳۳', 'completed', [['موکا', 1, 210000]]]
    ];
    sampleOrders.forEach(([customer, phone, status, items]) => {
      const total = items.reduce((sum, item) => sum + item[1] * item[2], 0);
      const orderId = Number(run('INSERT INTO orders (cafe_id,customer_name,customer_phone,status,total) VALUES (?,?,?,?,?)', cafeId, customer, phone, status, total).lastInsertRowid);
      items.forEach(([name, quantity, unitPrice]) => run('INSERT INTO order_items (order_id,product_name,quantity,unit_price) VALUES (?,?,?,?)', orderId, name, quantity, unitPrice));
    });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
seedDemo();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => { req.body ??= {}; next(); });
app.use('/uploads', express.static(uploadDir, { immutable: true, maxAge: '1y' }));
app.use((req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    if (origin) {
      try {
        const originHost = new URL(origin).host;
        if (originHost !== req.get('host') && !['localhost:5173', '127.0.0.1:5173'].includes(originHost)) return res.status(403).json({ error: 'درخواست از مبدأ نامعتبر است.' });
      } catch { return res.status(403).json({ error: 'مبدأ نامعتبر است.' }); }
    }
  }
  next();
});

/** Require a valid, unexpired session and attach its user to the request. */
function authenticate(req, res, next) {
  const token = (req.get('cookie') || '').split('; ').find(cookie => cookie.startsWith('cy_session='))?.slice(11);
  const hash = token && createHash('sha256').update(token).digest('hex');
  const user = hash && row('SELECT users.id, users.email, users.cafe_id FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?', hash, Date.now());
  if (!user) return res.status(401).json({ error: 'برای ادامه وارد حساب خود شوید.' });
  req.user = user;
  next();
}
/** Persist a new session and set its HttpOnly cookie on the response. */
function startSession(res, userId) {
  const token = randomBytes(32).toString('hex');
  run('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)', createHash('sha256').update(token).digest('hex'), userId, Date.now() + 7 * 86400000);
  res.cookie('cy_session', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 86400000, path: '/' });
}
/** Load the admin dashboard data belonging to one cafe. */
function cafeData(cafeId) {
  return {
    cafe: row('SELECT * FROM cafes WHERE id = ?', cafeId),
    categories: rows('SELECT * FROM categories WHERE cafe_id = ? ORDER BY sort_order, id', cafeId),
    products: rows('SELECT * FROM products WHERE cafe_id = ? ORDER BY id DESC', cafeId),
    gallery: rows('SELECT * FROM gallery WHERE cafe_id = ? ORDER BY id DESC', cafeId),
    orders: rows('SELECT * FROM orders WHERE cafe_id = ? ORDER BY id DESC', cafeId).map(order => ({ ...order, items: rows('SELECT product_name,quantity,unit_price FROM order_items WHERE order_id = ?', order.id) }))
  };
}
const fail = (res, message, code = 400) => res.status(code).json({ error: message });
const isSlug = slug => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 50;

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.post('/api/auth/demo', (_req, res) => { startSession(res, row('SELECT id FROM users WHERE email = ?', 'demo@cafeyar.ir').id); res.json({ ok: true }); });
app.post('/api/auth/login', (req, res) => {
  const user = row('SELECT * FROM users WHERE email = ?', value(req.body.email).toLowerCase());
  const password = String(req.body.password || '');
  const computed = user && hashPassword(password, user.salt);
  if (!user || !timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(user.password_hash, 'hex'))) return fail(res, 'ایمیل یا رمز عبور نادرست است.', 401);
  startSession(res, user.id);
  res.json({ ok: true });
});
app.post('/api/auth/register', (req, res) => {
  const email = value(req.body.email).toLowerCase();
  const name = value(req.body.name);
  const cafeName = value(req.body.cafeName);
  const slug = value(req.body.slug).toLowerCase();
  const password = String(req.body.password || '');
  if (!name || !cafeName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !isSlug(slug) || password.length < 8) return fail(res, 'اطلاعات را کامل کنید؛ رمز حداقل ۸ کاراکتر و آدرس فقط حروف انگلیسی کوچک، عدد و خط تیره باشد.');
  if (row('SELECT id FROM cafes WHERE slug = ?', slug) || row('SELECT id FROM users WHERE email = ?', email)) return fail(res, 'این ایمیل یا آدرس کافه قبلاً ثبت شده است.', 409);
  db.exec('BEGIN');
  try {
    const cafeId = Number(run('INSERT INTO cafes (slug,name,description) VALUES (?,?,?)', slug, cafeName, `به ${cafeName} خوش آمدید.`).lastInsertRowid);
    const salt = randomBytes(16).toString('hex');
    const userId = Number(run('INSERT INTO users (cafe_id,email,password_hash,salt) VALUES (?,?,?,?)', cafeId, email, hashPassword(password, salt), salt).lastInsertRowid);
    run('INSERT INTO categories (cafe_id,name) VALUES (?,?)', cafeId, 'نوشیدنی‌ها');
    db.exec('COMMIT');
    startSession(res, userId);
    res.status(201).json({ ok: true });
  } catch (error) { db.exec('ROLLBACK'); throw error; }
});
app.post('/api/auth/logout', authenticate, (req, res) => {
  const token = (req.get('cookie') || '').split('; ').find(cookie => cookie.startsWith('cy_session='))?.slice(11);
  run('DELETE FROM sessions WHERE token_hash = ?', createHash('sha256').update(token).digest('hex'));
  res.clearCookie('cy_session', { path: '/' });
  res.json({ ok: true });
});
app.get('/api/auth/me', authenticate, (req, res) => res.json({ user: req.user, cafe: row('SELECT * FROM cafes WHERE id = ?', req.user.cafe_id) }));
app.get('/api/admin/bootstrap', authenticate, (req, res) => res.json(cafeData(req.user.cafe_id)));

app.post('/api/admin/categories', authenticate, (req, res) => {
  const name = value(req.body.name, 80);
  if (!name) return fail(res, 'نام دسته‌بندی را وارد کنید.');
  const result = run('INSERT INTO categories (cafe_id,name,sort_order) VALUES (?,?,?)', req.user.cafe_id, name, Number(req.body.sort_order) || 0);
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});
app.patch('/api/admin/categories/:id', authenticate, (req, res) => {
  const name = value(req.body.name, 80);
  if (!name) return fail(res, 'نام دسته‌بندی را وارد کنید.');
  const result = run('UPDATE categories SET name = ? WHERE id = ? AND cafe_id = ?', name, req.params.id, req.user.cafe_id);
  if (!result.changes) return fail(res, 'دسته‌بندی پیدا نشد.', 404);
  res.json({ ok: true });
});
app.delete('/api/admin/categories/:id', authenticate, (req, res) => {
  const result = run('DELETE FROM categories WHERE id = ? AND cafe_id = ?', req.params.id, req.user.cafe_id);
  if (!result.changes) return fail(res, 'دسته‌بندی پیدا نشد.', 404);
  res.json({ ok: true });
});

/** Validate and normalize product fields for the specified cafe. */
function productInput(body, cafeId) {
  const name = value(body.name, 100);
  const price = Number(body.price);
  const categoryId = body.category_id === '' || body.category_id == null ? null : Number(body.category_id);
  if (!name || !Number.isSafeInteger(price) || price < 0) throw new InputError('نام و قیمت معتبر محصول را وارد کنید.');
  if (categoryId !== null && (!Number.isSafeInteger(categoryId) || categoryId < 1 || !row('SELECT id FROM categories WHERE id = ? AND cafe_id = ?', categoryId, cafeId))) throw new InputError('دسته‌بندی نامعتبر است.');
  return { name, price, categoryId, description: value(body.description, 500), imageUrl: validImageUrl(body.image_url), available: body.available === false || body.available === 0 ? 0 : 1, featured: body.featured === true || body.featured === 1 ? 1 : 0 };
}
app.post('/api/admin/products', authenticate, (req, res) => {
  const product = productInput(req.body, req.user.cafe_id);
  const result = run('INSERT INTO products (cafe_id,category_id,name,description,price,image_url,available,featured) VALUES (?,?,?,?,?,?,?,?)', req.user.cafe_id, product.categoryId, product.name, product.description, product.price, product.imageUrl, product.available, product.featured);
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});
app.patch('/api/admin/products/:id', authenticate, (req, res) => {
  const product = productInput(req.body, req.user.cafe_id);
  const result = run('UPDATE products SET category_id=?,name=?,description=?,price=?,image_url=?,available=?,featured=? WHERE id=? AND cafe_id=?', product.categoryId, product.name, product.description, product.price, product.imageUrl, product.available, product.featured, req.params.id, req.user.cafe_id);
  if (!result.changes) return fail(res, 'محصول پیدا نشد.', 404);
  res.json({ ok: true });
});
app.delete('/api/admin/products/:id', authenticate, (req, res) => {
  const result = run('DELETE FROM products WHERE id = ? AND cafe_id = ?', req.params.id, req.user.cafe_id);
  if (!result.changes) return fail(res, 'محصول پیدا نشد.', 404);
  res.json({ ok: true });
});

app.patch('/api/admin/cafe', authenticate, (req, res) => {
  const fields = ['name', 'slug', 'description', 'address', 'phone', 'hours', 'instagram', 'accent', 'cover_url'];
  const updates = fields.filter(field => Object.hasOwn(req.body, field));
  if (!updates.length) return fail(res, 'اطلاعاتی برای ویرایش ارسال نشده است.');
  const values = updates.map(field => field === 'cover_url' ? validImageUrl(req.body[field]) : value(req.body[field], field === 'description' ? 700 : 250));
  if (updates.includes('name') && !values[updates.indexOf('name')]) return fail(res, 'نام کافه لازم است.');
  if (updates.includes('slug') && !isSlug(values[updates.indexOf('slug')])) return fail(res, 'آدرس کافه باید شامل حروف کوچک انگلیسی، عدد و خط تیره باشد.');
  if (updates.includes('slug') && row('SELECT id FROM cafes WHERE slug = ? AND id != ?', values[updates.indexOf('slug')], req.user.cafe_id)) return fail(res, 'این آدرس قبلاً ثبت شده است.', 409);
  if (updates.includes('accent') && !/^#[0-9a-fA-F]{6}$/.test(values[updates.indexOf('accent')])) return fail(res, 'رنگ نامعتبر است.');
  run(`UPDATE cafes SET ${updates.map(field => `${field} = ?`).join(', ')} WHERE id = ?`, ...values, req.user.cafe_id);
  res.json({ ok: true });
});
app.post('/api/admin/gallery', authenticate, (req, res) => {
  const image = validImageUrl(req.body.image_url);
  if (!image) return fail(res, 'تصویر را انتخاب کنید.');
  const result = run('INSERT INTO gallery (cafe_id,image_url) VALUES (?,?)', req.user.cafe_id, image);
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});
app.delete('/api/admin/gallery/:id', authenticate, (req, res) => {
  const result = run('DELETE FROM gallery WHERE id=? AND cafe_id=?', req.params.id, req.user.cafe_id);
  if (!result.changes) return fail(res, 'تصویر پیدا نشد.', 404);
  res.json({ ok: true });
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
app.post('/api/admin/upload', authenticate, upload.single('image'), (req, res) => {
  if (!req.file) return fail(res, 'فایل تصویر را انتخاب کنید.');
  const buffer = req.file.buffer;
  let extension;
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) extension = 'jpg';
  else if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) extension = 'png';
  else if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') extension = 'webp';
  if (!extension) return fail(res, 'فقط تصاویر JPEG، PNG یا WebP مجاز هستند.');
  const filename = `${randomUUID()}.${extension}`;
  writeFileSync(path.join(uploadDir, filename), buffer, { flag: 'wx' });
  res.status(201).json({ url: `/uploads/${filename}` });
});

app.patch('/api/admin/orders/:id', authenticate, (req, res) => {
  const status = value(req.body.status, 30);
  if (!['new', 'preparing', 'ready', 'completed', 'cancelled'].includes(status)) return fail(res, 'وضعیت نامعتبر است.');
  const result = run('UPDATE orders SET status=? WHERE id=? AND cafe_id=?', status, req.params.id, req.user.cafe_id);
  if (!result.changes) return fail(res, 'سفارش پیدا نشد.', 404);
  res.json({ ok: true });
});
app.get('/api/public/:slug', (req, res) => {
  const cafe = row('SELECT * FROM cafes WHERE slug = ?', req.params.slug);
  if (!cafe) return fail(res, 'کافه پیدا نشد.', 404);
  res.json({ cafe, categories: rows('SELECT * FROM categories WHERE cafe_id=? ORDER BY sort_order,id', cafe.id), products: rows('SELECT * FROM products WHERE cafe_id=? AND available=1 ORDER BY featured DESC,id DESC', cafe.id), gallery: rows('SELECT * FROM gallery WHERE cafe_id=? ORDER BY id DESC', cafe.id) });
});
app.post('/api/public/:slug/orders', (req, res) => {
  const cafe = row('SELECT id FROM cafes WHERE slug = ?', req.params.slug);
  if (!cafe) return fail(res, 'کافه پیدا نشد.', 404);
  const name = value(req.body.customer_name, 100);
  const phone = value(req.body.customer_phone, 40);
  const items = req.body.items;
  if (!name || !phone || !Array.isArray(items) || !items.length || items.length > 40) return fail(res, 'نام، شماره تماس و محصولات سفارش را کامل کنید.');
  const selected = items.map(item => {
    if (!item || !Number.isSafeInteger(Number(item.product_id)) || Number(item.product_id) < 1) throw new InputError('یکی از محصولات یا تعداد سفارش معتبر نیست.');
    const quantity = Number(item.quantity);
    const product = row('SELECT id,name,price FROM products WHERE id=? AND cafe_id=? AND available=1', item.product_id, cafe.id);
    if (!product || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) throw new InputError('یکی از محصولات یا تعداد سفارش معتبر نیست.');
    return { ...product, quantity };
  });
  const total = selected.reduce((sum, item) => sum + item.price * item.quantity, 0);
  if (!Number.isSafeInteger(total)) return fail(res, 'مبلغ سفارش معتبر نیست.');
  db.exec('BEGIN');
  try {
    const orderId = Number(run('INSERT INTO orders (cafe_id,customer_name,customer_phone,note,total) VALUES (?,?,?,?,?)', cafe.id, name, phone, value(req.body.note, 500), total).lastInsertRowid);
    selected.forEach(item => run('INSERT INTO order_items (order_id,product_id,product_name,quantity,unit_price) VALUES (?,?,?,?,?)', orderId, item.id, item.name, item.quantity, item.price));
    db.exec('COMMIT');
    res.status(201).json({ id: orderId, total });
  } catch (error) { db.exec('ROLLBACK'); throw error; }
});

app.get('/api/admin/ai/context', authenticate, (req, res) => {
  const cafeId = req.user.cafe_id;
  res.json({
    cafe: row('SELECT name,description,hours FROM cafes WHERE id=?', cafeId),
    products: rows('SELECT name,description,price,available FROM products WHERE cafe_id=? ORDER BY id', cafeId),
    sales: rows("SELECT order_items.product_name AS name, SUM(order_items.quantity) AS units, SUM(order_items.quantity * order_items.unit_price) AS revenue FROM order_items JOIN orders ON orders.id=order_items.order_id WHERE orders.cafe_id=? AND orders.status!='cancelled' GROUP BY order_items.product_name ORDER BY units DESC", cafeId)
  });
});

const dist = path.join(root, 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}
app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) return fail(res, 'حجم تصویر باید کمتر از ۵ مگابایت باشد.');
  if (error instanceof SyntaxError && error.status === 400) return fail(res, 'ساختار درخواست نامعتبر است.');
  if (error.message && /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(error.message)) return fail(res, 'این اطلاعات قبلاً ثبت شده‌اند.', 409);
  if (error instanceof InputError) return fail(res, error.message);
  console.error(error);
  return fail(res, 'خطایی رخ داد. لطفاً دوباره تلاش کنید.', 500);
});

const port = Number(process.env.PORT || 3001);
app.listen(port, '0.0.0.0', () => console.log(`Café Yar API listening on ${port}`));
