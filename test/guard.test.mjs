import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProfile,
  stripSql,
  findViolation,
  assertQueryAllowed,
  describeExecuteQueryTool,
} from '../dist/guard.js';

describe('parseProfile', () => {
  test('retorna reader quando não definido', () => {
    assert.equal(parseProfile(undefined), 'reader');
    assert.equal(parseProfile(''), 'reader');
  });

  test('aceita os três perfis', () => {
    assert.equal(parseProfile('reader'), 'reader');
    assert.equal(parseProfile('dml'), 'dml');
    assert.equal(parseProfile('ddl'), 'ddl');
  });

  test('é case-insensitive', () => {
    assert.equal(parseProfile('READER'), 'reader');
    assert.equal(parseProfile('Dml'), 'dml');
  });

  test('rejeita valor inválido', () => {
    assert.throws(() => parseProfile('admin'), /MSSQL_PROFILE/);
  });
});

describe('stripSql', () => {
  test('remove comentário de linha', () => {
    assert.doesNotMatch(stripSql('SELECT 1 -- DELETE FROM t'), /DELETE/);
  });

  test('remove comentário de bloco aninhado', () => {
    assert.doesNotMatch(stripSql('SELECT 1 /* a /* DROP */ TRUNCATE */'), /DROP|TRUNCATE/);
  });

  test('remove literais de string com escape de aspas', () => {
    assert.doesNotMatch(stripSql("SELECT 'it''s a DELETE'"), /DELETE/);
  });

  test('remove literais N\'...\'', () => {
    assert.doesNotMatch(stripSql("SELECT N'DROP TABLE x'"), /DROP/);
  });

  test('-- dentro de string não inicia comentário', () => {
    const out = stripSql("SELECT '--' , 2 FROM t");
    assert.match(out, /FROM/);
  });

  test('aspas simples dentro de comentário não iniciam string', () => {
    const out = stripSql("SELECT 1 /* it's */ FROM t");
    assert.match(out, /FROM/);
  });

  test('identificadores entre colchetes não geram palavras-chave', () => {
    assert.doesNotMatch(stripSql('SELECT * FROM [DROP TABLE]'), /DROP|TABLE/);
  });

  test('escape ]] em colchetes', () => {
    assert.doesNotMatch(stripSql('SELECT * FROM [a]]DELETE] WHERE 1=1'), /DELETE/);
    assert.match(stripSql('SELECT * FROM [a]]DELETE] WHERE 1=1'), /WHERE/);
  });

  test('identificadores entre aspas duplas não geram palavras-chave', () => {
    assert.doesNotMatch(stripSql('SELECT "delete" FROM t'), /delete/i);
  });

  test('literal não terminado é removido até o fim', () => {
    assert.doesNotMatch(stripSql("SELECT 'aberto DELETE FROM t"), /DELETE/);
  });
});

describe('findViolation — perfil reader', () => {
  const ok = (q) => assert.equal(findViolation(q, 'reader'), null, `esperava permitir: ${q}`);
  const deny = (q, kw) => {
    const v = findViolation(q, 'reader');
    assert.ok(v, `esperava bloquear: ${q}`);
    if (kw) assert.equal(v.keyword, kw);
    return v;
  };

  test('permite SELECT simples', () => {
    ok('SELECT * FROM clientes WHERE id = 1');
  });

  test('permite múltiplos SELECTs com e sem ponto e vírgula', () => {
    ok('SELECT 1; SELECT 2;');
    ok('SELECT 1 SELECT 2');
  });

  test('permite CTE terminando em SELECT', () => {
    ok('WITH x AS (SELECT id FROM t) SELECT * FROM x');
  });

  test('permite DECLARE/SET/IF/BEGIN-END', () => {
    ok("DECLARE @n INT; SET @n = 1; IF @n = 1 BEGIN SELECT @n END");
  });

  test('permite FETCH ... INTO variável', () => {
    ok('FETCH NEXT FROM cur INTO @v');
  });

  test('palavras-chave em strings/comentários não bloqueiam', () => {
    ok("SELECT '-- DELETE' AS a");
    ok('SELECT 1 /* DROP TABLE x */');
    ok("SELECT 'DELETE FROM t' FROM logs");
  });

  test('tokens com @/#/sufixos não são palavras-chave', () => {
    ok('SELECT @update FROM t');
    ok('SELECT * FROM #delete');
    ok('SELECT delete_flag, deleted.name FROM t, deleted');
  });

  test('bloqueia DML básico', () => {
    assert.equal(deny('INSERT INTO t VALUES (1)', 'INSERT').requiredProfile, 'dml');
    assert.equal(deny('UPDATE t SET a = 1', 'UPDATE').requiredProfile, 'dml');
    assert.equal(deny('DELETE FROM t', 'DELETE').requiredProfile, 'dml');
    assert.equal(deny('MERGE t USING s ON 1=1 WHEN MATCHED THEN UPDATE SET a=1;', 'MERGE').requiredProfile, 'dml');
  });

  test('bloqueia CTE terminando em DELETE', () => {
    deny('WITH x AS (SELECT id FROM t) DELETE FROM x', 'DELETE');
  });

  test('bloqueia DML sem ponto e vírgula após SELECT', () => {
    deny('SELECT 1 DELETE FROM t', 'DELETE');
  });

  test('bloqueia SELECT ... INTO (cria tabela)', () => {
    const v = deny('SELECT * INTO novo FROM t');
    assert.equal(v.requiredProfile, 'ddl');
  });

  test('bloqueia transações', () => {
    deny('BEGIN TRAN UPDATE t SET a=1 COMMIT');
    deny('BEGIN TRANSACTION');
    deny('COMMIT');
  });

  test('bloqueia EXEC e INSERT...EXEC', () => {
    assert.equal(deny('EXEC sp_who', 'EXEC').requiredProfile, 'ddl');
    deny("EXECUTE sp_executesql N'x'");
    deny('INSERT INTO t EXEC p');
  });

  test('bloqueia DDL e comandos administrativos', () => {
    assert.equal(deny('CREATE TABLE t (id INT)', 'CREATE').requiredProfile, 'ddl');
    deny('DROP TABLE t', 'DROP');
    deny('TRUNCATE TABLE t', 'TRUNCATE');
    deny('ALTER TABLE t ADD b INT', 'ALTER');
    deny('GRANT SELECT ON t TO u', 'GRANT');
    deny('BACKUP DATABASE d TO DISK = @p', 'BACKUP');
    deny('DBCC CHECKDB', 'DBCC');
  });

  test('bloqueia instruções desconhecidas (allowlist estrita)', () => {
    const v = deny('KILL 55', 'KILL');
    assert.equal(v.requiredProfile, 'ddl');
    const v2 = deny('sp_who');
    assert.equal(v2.requiredProfile, null);
  });

  test('bloqueia OPENROWSET/OPENQUERY em qualquer profundidade', () => {
    deny("SELECT * FROM OPENQUERY(ln, 'DELETE FROM t')", 'OPENQUERY');
    deny("SELECT * FROM (SELECT * FROM OPENROWSET(BULK N'f', SINGLE_BLOB) AS x) y");
  });
});

describe('findViolation — perfil dml', () => {
  const ok = (q) => assert.equal(findViolation(q, 'dml'), null, `esperava permitir: ${q}`);
  const deny = (q) => assert.ok(findViolation(q, 'dml'), `esperava bloquear: ${q}`);

  test('permite escrita DML e transações', () => {
    ok('INSERT INTO t VALUES (1)');
    ok('UPDATE t SET a = 1 WHERE id = 2');
    ok('DELETE FROM t WHERE id = 3');
    ok('MERGE t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = 1 WHEN NOT MATCHED THEN INSERT (a) VALUES (s.a);');
    ok('WITH x AS (SELECT id FROM t) UPDATE t SET a = 1 FROM t JOIN x ON t.id = x.id');
    ok('BEGIN TRAN UPDATE t SET a = 1 COMMIT');
  });

  test('ainda bloqueia DDL, EXEC e SELECT INTO', () => {
    deny('CREATE TABLE t (id INT)');
    deny('TRUNCATE TABLE t');
    deny('EXEC sp_who');
    deny('SELECT * INTO novo FROM t');
    deny('DROP TABLE t');
  });
});

describe('findViolation — perfil ddl', () => {
  test('permite tudo', () => {
    assert.equal(findViolation('DROP DATABASE producao', 'ddl'), null);
    assert.equal(findViolation('EXEC xp_cmdshell @c', 'ddl'), null);
    assert.equal(findViolation('qualquer coisa aqui', 'ddl'), null);
  });
});

describe('assertQueryAllowed', () => {
  test('lança erro em pt-BR nomeando perfil e instrução', () => {
    assert.throws(
      () => assertQueryAllowed('DELETE FROM t', 'reader'),
      (err) => {
        assert.match(err.message, /perfil/i);
        assert.match(err.message, /"reader"/);
        assert.match(err.message, /DELETE/);
        assert.match(err.message, /"dml"/);
        assert.match(err.message, /MSSQL_PROFILE/);
        return true;
      }
    );
  });

  test('não lança quando permitido', () => {
    assert.doesNotThrow(() => assertQueryAllowed('SELECT 1', 'reader'));
  });
});

describe('describeExecuteQueryTool', () => {
  test('menciona o perfil ativo em cada modo', () => {
    assert.match(describeExecuteQueryTool('reader'), /"reader"/);
    assert.match(describeExecuteQueryTool('dml'), /"dml"/);
    assert.match(describeExecuteQueryTool('ddl'), /"ddl"/);
  });
});
