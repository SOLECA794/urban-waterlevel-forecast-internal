set -e
B=http://127.0.0.1:8200
J=/tmp/wljar
rm -f $J
cat > /tmp/login.json <<'J'
{"username":"admin","password":"admin123"}
J
curl.exe --noproxy '*' -s -c $J -H "Content-Type: application/json" --data-binary @/tmp/login.json $B/api/auth/login -o /dev/null -w "login=%{http_code}\n"
curl.exe --noproxy '*' -s -b $J -X POST "$B/api/sim/storm?peak=200&dur=38" -w "\nstorm=%{http_code}\n"
