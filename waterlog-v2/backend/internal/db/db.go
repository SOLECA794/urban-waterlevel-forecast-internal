// Package db SQLite 打开、迁移与种子。
package db

import (
	"embed"
	"fmt"
	"os"
	"path/filepath"

	"github.com/jmoiron/sqlx"
	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// DB 数据库句柄。
type DB struct {
	*sqlx.DB
}

// Open 打开数据库并执行全部迁移（幂等 DDL）。
func Open(path string) (*DB, error) {
	if dir := filepath.Dir(path); dir != "." && dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("创建数据目录失败: %w", err)
		}
	}
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=foreign_keys(ON)&_pragma=busy_timeout(5000)", path)
	sqlxDB, err := sqlx.Connect("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("打开 SQLite 失败: %w", err)
	}
	sqlxDB.SetMaxOpenConns(1) // modernc sqlite 单写者
	d := &DB{sqlxDB}
	if err := d.migrate(); err != nil {
		_ = sqlxDB.Close()
		return nil, err
	}
	return d, nil
}

func (d *DB) migrate() error {
	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		return err
	}
	for _, e := range entries {
		b, err := migrationsFS.ReadFile("migrations/" + e.Name())
		if err != nil {
			return err
		}
		if _, err := d.Exec(string(b)); err != nil {
			return fmt.Errorf("迁移 %s 失败: %w", e.Name(), err)
		}
	}
	return nil
}
