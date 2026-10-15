#!/data/data/com.termux/files/usr/bin/bash
# One-time setup: install Python and start the Now Playing web server on 127.0.0.1:8080.
export DEBIAN_FRONTEND=noninteractive
yes | pkg update -y -o Dpkg::Options::=--force-confnew
pkg install -y python

cat > ~/start-spotify-monitor.sh <<'EOS'
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock 2>/dev/null
cd /sdcard/spotify-monitor
exec python -m http.server 8080 --bind 127.0.0.1
EOS
chmod +x ~/start-spotify-monitor.sh

# Start the server automatically whenever Termux opens.
grep -q start-spotify-monitor ~/.bashrc 2>/dev/null || \
  echo 'pgrep -f "http.server 8080" >/dev/null || (nohup ~/start-spotify-monitor.sh >~/sm.log 2>&1 &)' >> ~/.bashrc

pgrep -f "http.server 8080" >/dev/null || (nohup ~/start-spotify-monitor.sh >~/sm.log 2>&1 &)
sleep 2
echo "Server running at http://127.0.0.1:8080/"
