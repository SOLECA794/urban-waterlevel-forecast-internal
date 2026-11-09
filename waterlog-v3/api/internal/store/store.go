// Package store 是 v3 的本地存储（SQLite）。
//
// 只负责"存"：建表/迁移、遥测、快照、预警事件、决策日志、处置备注。
// 不掺业务判断——唯一的例外是 SyncWarning 的四态推进，因为它必须在
// 一个事务语义里判定迁移是否合法，拆到别处反而会变成两处状态。
package store

import (
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"sort"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// migrationsFS 内嵌版本化 SQL。目录必须在包目录内（embed 不能跨包读），
// 所以最终落在 internal/store/migrations/ 而不是 api/migrations/。
//
//go:embed migrations/*.sql
var migrationsFS embed.FS

// Store 持有数据库连接与一把进程内读写锁。
type Store struct {
	db *sql.DB
	mu sync.RWMutex
}

// OpenStore 打开（必要时创建）数据库，按文件名顺序执行 migrations/*.sql，
// 然后做老库的列补齐。
func OpenStore(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	if err := applyMigrations(db); err != nil {
		return nil, fmt.Errorf("schema: %w", err)
	}
	st := &Store{db: db}
	// 老库的 warning_event 没有处置列，CREATE TABLE IF NOT EXISTS 补不上，
	// 必须显式 ALTER（见 migrateWarning）。
	if err := st.migrateWarning(); err != nil {
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return st, nil
}

// applyMigrations 按文件名排序执行内嵌的 SQL 文件。
// 文件名即版本号（0001_init.sql、0002_xxx.sql…），新增迁移只能往后加。
func applyMigrations(db *sql.DB) error {
	names, err := fs.Glob(migrationsFS, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(names)
	for _, name := range names {
		ddl, err := migrationsFS.ReadFile(name)
		if err != nil {
			return err
		}
		if _, err := db.Exec(string(ddl)); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
	}
	return nil
}

// migrateWarning 给已存在的 warning_event 表补处置列。
//
// 这是"平滑升级已有库"的必备步骤：CREATE TABLE IF NOT EXISTS 对已存在的表
// 不会加字段，只能先 PRAGMA table_info 看有哪些列，再逐列 ALTER TABLE ADD COLUMN。
func (s *Store) migrateWarning() error {
	have := map[string]bool{}
	rows, err := s.db.Query(`PRAGMA table_info(warning_event)`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var cid, notnull, pk int
		var name, typ string
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk); err != nil {
			rows.Close()
			return err
		}
		have[name] = true
	}
	rows.Close()

	// CREATE TABLE IF NOT EXISTS 不会给已存在的表加字段，老库必须显式 ALTER
	adds := []struct{ col, ddl string }{
		{"disposition", `ALTER TABLE warning_event ADD COLUMN disposition TEXT NOT NULL DEFAULT 'open'`},
		{"assignee", `ALTER TABLE warning_event ADD COLUMN assignee TEXT`},
	}
	for _, a := range adds {
		if have[a.col] {
			continue
		}
		if _, err := s.db.Exec(a.ddl); err != nil {
			return fmt.Errorf("migrate %s: %w", a.col, err)
		}
	}
	return nil
}

// Close 关闭数据库连接。
func (s *Store) Close() error { return s.db.Close() }

// NowTS 返回遥测时钟的"当前时刻"。
//
// 模拟器按 60x 推进（5 秒真实时间 = 5 分钟仿真时间），所以仿真时间会跑到真实时间前面。
// 所有窗口查询（趋势、历史、火花线）都必须以最新遥测时刻为基准，混用 time.Now() 会把
// 一小时的窗口算成一天，趋势斜率直接失真。
func (s *Store) NowTS() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var ts sql.NullInt64
	_ = s.db.QueryRow(`SELECT MAX(ts) FROM telemetry`).Scan(&ts)
	if ts.Valid {
		return ts.Int64
	}
	return time.Now().Unix()
}

// Prune 只保留最近 keepHours 小时的遥测，避免本地库无限长大。
func (s *Store) Prune(keepHours int) {
	cut := s.NowTS() - int64(keepHours*3600)
	s.mu.Lock()
	defer s.mu.Unlock()
	_, _ = s.db.Exec(`DELETE FROM telemetry WHERE ts < ?`, cut)
	_, _ = s.db.Exec(`DELETE FROM decision WHERE ts < ?`, cut)
	_, _ = s.db.Exec(`DELETE FROM forecast_snapshot WHERE issued_at < ?`, cut)
}
