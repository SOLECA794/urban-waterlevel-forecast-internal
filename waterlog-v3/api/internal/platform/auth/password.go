// Package auth 提供口令摘要与会话令牌的底层原语。
//
// 这里只做密码学，不做业务判断——谁可以登录、会话多久过期，都在 service 层。
// 单独拆一个 platform 包的理由：这类代码一旦写错就是安全事故，值得让它
// 有一个能被单独审阅、单独测试的位置。
package auth

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
)

const (
	// iterations 是 PBKDF2 迭代次数。12 万次在 2026 年的普通笔记本上约 40ms，
	// 登录感知不到，但把离线爆破的代价抬高了五个数量级。
	iterations = 120000
	saltLen    = 16
	keyLen     = 32

	// CookieName 是会话 cookie 的名字。
	CookieName = "wl_session"
)

// HashPassword 生成 "pbkdf2$<iter>$<salt_b64>$<hash_b64>" 形式的摘要。
//
// 把迭代次数写进摘要串而不是写死在代码里：以后调高 iterations 时，
// 老账号仍能用老参数验证通过，不需要强制所有人改密码。
func HashPassword(password string) (string, error) {
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, err := pbkdf2.Key(sha256.New, password, salt, iterations, keyLen)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("pbkdf2$%d$%s$%s",
		iterations,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

// VerifyPassword 校验明文口令是否匹配摘要。
//
// 用 subtle.ConstantTimeCompare 而不是 ==：字符串比较会在第一个不同字节处
// 提前返回，攻击者能靠计时差一点点试出摘要。这类比较必须常数时间。
func VerifyPassword(encoded, password string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2" {
		return false
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter <= 0 {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[3])
	if err != nil {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, password, salt, iter, len(want))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

// NewToken 生成一个 32 字节的随机会话令牌（base64url 编码）。
//
// 用 crypto/rand 而不是 math/rand：后者是可预测的伪随机，令牌可预测等于没有鉴权。
func NewToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// TokenHash 返回令牌的 SHA-256（十六进制）。
//
// 库里只存这个摘要，不存令牌原文：数据库文件泄露时，攻击者拿到的摘要
// 不能直接当 cookie 用。令牌本身是高熵随机串，不需要加盐慢哈希。
func TokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return fmt.Sprintf("%x", sum)
}
