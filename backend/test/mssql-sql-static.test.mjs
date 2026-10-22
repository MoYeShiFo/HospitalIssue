// v1.18.78 静态回归：mssqlFileStore 的 OUTPUT 子句位置检查。
// 背景：v1.18.77 updateFile 写成 `UPDATE ... OUTPUT INSERTED.* SET ...`——SQL Server 中
// UPDATE 的 OUTPUT 必须在 SET 之后，运行时报「Incorrect syntax near 'OUTPUT'」。
// dev 驱动测试无法触达 mssql 路径，故以源码静态断言钉住三类语句的合法子句顺序。
//
// 运行：cd backend && node test/mssql-sql-static.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'files', 'mssqlFileStore.js'), 'utf8');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS', msg); }
  else { failed++; console.error('  FAIL', msg); }
}

// updateFile：UPDATE ... SET ... OUTPUT INSERTED.* ...（OUTPUT 在 SET 之后）
assert(/UPDATE dbo\.app_file SET \$\{sets\.join\(', '\)\} OUTPUT INSERTED\.\* WHERE/.test(src),
  'updateFile：UPDATE 的 OUTPUT 位于 SET 之后（SQL Server 语法要求）');
// deleteFile：DELETE FROM ... OUTPUT DELETED.* WHERE（OUTPUT 在 WHERE 之前，合法）
assert(/DELETE FROM dbo\.app_file OUTPUT DELETED\.\* WHERE/.test(src),
  'deleteFile：DELETE 的 OUTPUT DELETED.* 前置于 WHERE（合法）');
// createFile：INSERT INTO ... OUTPUT INSERTED.* VALUES（OUTPUT 在 VALUES 之前，合法）
assert(/OUTPUT INSERTED\.\*\s*\n?\s*VALUES/.test(src),
  'createFile：INSERT 的 OUTPUT INSERTED.* 前置于 VALUES（合法）');
// removeByOrg：DELETE ... OUTPUT ... WHERE（合法）
assert(/DELETE FROM dbo\.app_file OUTPUT DELETED\.id, DELETED\.stored_name, DELETED\.original_name WHERE/.test(src),
  'removeByOrg：DELETE 的 OUTPUT 前置于 WHERE（合法）');
// 兜底：源码中不应再存在「UPDATE ... OUTPUT」这种非法顺序
assert(!/UPDATE dbo\.app_file OUTPUT/.test(src),
  '全文件不存在「UPDATE ... OUTPUT」非法顺序');

console.log(`\nRESULT: passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
