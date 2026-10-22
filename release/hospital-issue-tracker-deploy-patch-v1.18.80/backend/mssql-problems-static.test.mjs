// v1.18.80 静态回归：mssqlRepo 问题模块「角色可见范围」SQL 子句检查。
// 背景：dev 驱动测试无法触达 mssql 路径（长期盲区），viewer 过滤 SQL 必须以源码静态断言钉住，
// 保证与 db/problemScope.js 的 viewerMatches 口径逐条等价（红线）。
//
// 运行：cd backend && node test/mssql-problems-static.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'mssqlRepo.js'), 'utf8');
const scopeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'problemScope.js'), 'utf8');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS', msg); }
  else { failed++; console.error('  FAIL', msg); }
}

// viewer 参数注册：@v_name / @v_acct 各注册一次
assert(/input\('v_name', sql\.NVarChar\(100\), f\.viewer\.name \|\| ''\)/.test(src),
  'buildWhere 注册 @v_name 参数（NVarChar(100)）');
assert(/input\('v_acct', sql\.NVarChar\(100\), f\.viewer\.acct \|\| ''\)/.test(src),
  'buildWhere 注册 @v_acct 参数（NVarChar(100)）');
// 公司用户：handler / registrar 按姓名 + createdBy 按账号，三条件 OR
assert(/mode === 'company'[\s\S]*?LTRIM\(RTRIM\(ISNULL\(handler, N''\)\)\) = @v_name OR LTRIM\(RTRIM\(ISNULL\(registrar, N''\)\)\) = @v_name OR LTRIM\(RTRIM\(ISNULL\(createdBy, N''\)\)\) = @v_acct/.test(src),
  '公司用户三条件 OR：handler/registrar 姓名匹配 或 createdBy 账号匹配');
// 登记员：registrar 姓名匹配 或 createdBy 账号匹配
assert(/\(LTRIM\(RTRIM\(ISNULL\(registrar, N''\)\)\) = @v_name OR LTRIM\(RTRIM\(ISNULL\(createdBy, N''\)\)\) = @v_acct\)/.test(src),
  '登记员两条件 OR：registrar 姓名匹配 或 createdBy 账号匹配');
// mode=none fail-closed：1=0（与 viewerMatches 一致，绝不能漏过滤看全部）
assert(/mode === 'none'[\s\S]{0,120}clauses\.push\('\(1 = 0\)'\)/.test(src),
  'mode=none 走 fail-closed（1=0），不漏过滤');
// 统一 trim 口径：全部比较必须经 LTRIM(RTRIM(...))
assert(!/=\s*@v_name(?!\s*OR|=)/.test(src.replace(/LTRIM\(RTRIM\(ISNULL\((?:handler|registrar|createdBy), N''\)\)\) = @(?:v_name|v_acct)/g, '')),
  'viewer 比较一律经 LTRIM(RTRIM(...))（无裸比较）');
// 详情单行判定使用 viewerMatches（与 list 口径同源）
assert(/viewerMatches\(rec, viewer\) \? rec : null/.test(src),
  'get(id, orgId, viewer) 用 viewerMatches 单行判定');
// problemScope viewerMatches 仍为 fail-closed 兜底
assert(/if \(viewer\.mode === 'none'\) return false;/.test(scopeSrc),
  'problemScope.viewerMatches：mode=none 返回 false（fail-closed）');

console.log(`\nRESULT: passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
