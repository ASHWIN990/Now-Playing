#!/data/data/com.termux/files/usr/bin/bash
# Installs the Termux:Boot script that starts the Now Playing server at phone boot.
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/start-spotify-monitor <<'EOS'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
pgrep -f "http.server 8080" >/dev/null || nohup ~/start-spotify-monitor.sh >~/sm.log 2>&1 &
EOS
chmod +x ~/.termux/boot/start-spotify-monitor
ls -l ~/.termux/boot/
