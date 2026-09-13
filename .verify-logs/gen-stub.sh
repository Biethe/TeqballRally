#!/bin/bash
# Generate a stub libasound.so.2 exporting every ALSA symbol chrome links,
# versioned exactly as the binary expects. All calls fail cleanly (-1 / no
# devices), and chrome runs muted headless without audio.
set -e
cd /home/bierh/TeqballRally/.verify-logs
CHROME=/home/bierh/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome

objdump -T "$CHROME" | grep "\*UND\*" | grep "snd_" \
  | sed -E 's/.*\(([^)]*)\)[[:space:]]+([A-Za-z_0-9]+)$/\1 \2/' | sort -u > syms.txt

{
  echo '#include <stddef.h>'
  echo 'static const char empty_str[] = "";'
  echo 'static const char err_str[] = "stub ALSA: no audio";'
  # Special bodies first.
  echo 'const char *snd_strerror(int e) { (void)e; return err_str; }'
  echo 'int snd_card_next(int *card) { if (card) *card = -1; return 0; }'
  echo 'const char *snd_pcm_name(void *p) { (void)p; return empty_str; }'
  echo 'const char *snd_ctl_card_info_get_name(void *p) { (void)p; return empty_str; }'
  echo 'const char *snd_ctl_card_info_get_longname(void *p) { (void)p; return empty_str; }'
  echo 'const char *snd_ctl_card_info_get_driver(void *p) { (void)p; return empty_str; }'
  echo 'const char *snd_seq_client_info_get_name(void *p) { (void)p; return empty_str; }'
  echo 'const char *snd_seq_port_info_get_name(void *p) { (void)p; return empty_str; }'
  echo 'const char *snd_mixer_selem_get_name(void *p) { (void)p; return empty_str; }'
  echo 'void *snd_device_name_get_hint(void *h, const char *n) { (void)h; (void)n; return NULL; }'
  echo 'long snd_pcm_format_size(int f, long s) { (void)f; return s > 0 ? 2 : -1; }'
  for f in snd_pcm_hw_params_sizeof snd_pcm_sw_params_sizeof snd_ctl_card_info_sizeof \
           snd_hwdep_info_sizeof snd_seq_client_info_sizeof snd_seq_port_info_sizeof \
           snd_seq_port_subscribe_sizeof; do
    echo "long ${f}(void) { return 256; }"
  done
  # Generic failing stubs for everything else.
  while read -r ver name; do
    case "$name" in
      snd_strerror|snd_card_next|snd_pcm_name|snd_ctl_card_info_get_name|snd_ctl_card_info_get_longname|snd_ctl_card_info_get_driver|snd_seq_client_info_get_name|snd_seq_port_info_get_name|snd_mixer_selem_get_name|snd_device_name_get_hint|snd_pcm_format_size|snd_pcm_hw_params_sizeof|snd_pcm_sw_params_sizeof|snd_ctl_card_info_sizeof|snd_hwdep_info_sizeof|snd_seq_client_info_sizeof|snd_seq_port_info_sizeof|snd_seq_port_subscribe_sizeof) continue;;
    esac
    echo "long ${name}(void) { return -1; }"
  done < syms.txt
  # Versioned aliases.
  while read -r ver name; do
    echo "__asm__(\".symver ${name},${name}@${ver}\");"
  done < syms.txt
} > stub_alsa.c

{
  echo "ALSA_0.9 {"
  echo "  global:"
  awk '$1=="ALSA_0.9"{print "    "$2";"}' syms.txt
  echo "};"
  echo "ALSA_0.9.0rc4 {"
  echo "  global:"
  awk '$1=="ALSA_0.9.0rc4"{print "    "$2";"}' syms.txt
  echo "};"
} > alsa.map

gcc -shared -fPIC -w -Wl,--version-script=alsa.map -o libasound.so.2 stub_alsa.c
echo "built: $(ls -la libasound.so.2 | awk '{print $5}') bytes, $(wc -l < syms.txt) symbols"
