#!/usr/bin/env bash
# Portable control-byte stripping, shared with the ADP review sanitizer.
strip_ansi() {
  LC_ALL=C awk '
    BEGIN {
      for (i = 0; i < 256; i++) ORD[sprintf("%c", i)] = i
      # Second-byte bounds rejecting overlong forms, surrogates and out-of-range code
      # points — accepting them would let a crafted sequence carry a C1 byte past this
      # validity check to a renderer that decodes it leniently.
      LO[224] = 160; HI[224] = 191; LO[237] = 128; HI[237] = 159
      LO[240] = 144; HI[240] = 191; LO[244] = 128; HI[244] = 143
    }
    function b(i) { return ORD[substr(L, i, 1)] }
    function seqlen(i,   v, need, lo, hi, k) {
      v = b(i)
      if (v >= 194 && v <= 223) need = 1
      else if (v >= 224 && v <= 239) need = 2
      else if (v >= 240 && v <= 244) need = 3
      else return 0
      if (i + need > N) return 0
      lo = (v in LO) ? LO[v] : 128
      hi = (v in HI) ? HI[v] : 191
      if (b(i + 1) < lo || b(i + 1) > hi) return 0
      for (k = 2; k <= need; k++) if (b(i + k) < 128 || b(i + k) > 191) return 0
      return need + 1
    }
    function csi(i,   j) {   # parameter bytes, intermediates, one final byte
      j = i
      while (j <= N && b(j) >= 48 && b(j) <= 63) j++
      while (j <= N && b(j) >= 32 && b(j) <= 47) j++
      if (j <= N && b(j) >= 64 && b(j) <= 126) j++
      return j
    }
    # Terminator forms: BEL, raw ST, ESC-backslash, and ST as its UTF-8 encoding C2 9C.
    # Payload bytes are stepped over a whole UTF-8 sequence at a time, so a continuation
    # byte that happens to be 0x9c (`한` = ED 95 9C) is not mistaken for a terminator.
    function esc_final(i,   j) {   # intermediates 0x20-0x2f then one final byte 0x30-0x7e
      j = i
      while (j <= N && b(j) >= 32 && b(j) <= 47) j++
      if (j <= N && b(j) >= 48 && b(j) <= 126) j++
      return j
    }
    function ctlstr(i,   j, m) {
      j = i
      while (j <= N) {
        if (b(j) == 7 || b(j) == 156) return j + 1
        if (b(j) == 27 && j < N && b(j + 1) == 92) return j + 2
        if (b(j) == 194 && j < N && b(j + 1) == 156) return j + 2
        m = seqlen(j)
        j += (m ? m : 1)
      }
      return j
    }
    {
      L = $0; N = length(L); out = ""; i = 1
      while (i <= N) {
        # C2 80-C2 9F is structurally valid UTF-8 AND the canonical encoding of U+0080-U+009F,
        # i.e. the same C1 controls handled in raw-byte form below. Checked before seqlen or
        # it is emitted as ordinary text, re-opening the invisible credential split: browsers
        # render Cc code points as nothing and UTF-8 terminals decode them as controls
        # (PR#85 review L3). No legitimate text encodes these code points.
        if (b(i) == 194 && i < N && b(i + 1) >= 128 && b(i + 1) <= 159) {
          w = b(i + 1)
          if (w == 155) i = csi(i + 2)
          else if (w == 157 || w == 144 || w == 152 || w == 158 || w == 159) i = ctlstr(i + 2)
          else i += 2
          continue
        }
        n = seqlen(i)
        if (n) { out = out substr(L, i, n); i += n; continue }
        v = b(i)
        if (v == 27) {
          w = (i < N) ? b(i + 1) : -1
          if (w == 91) i = csi(i + 2)
          else if (w == 93 || w == 80 || w == 88 || w == 94 || w == 95) i = ctlstr(i + 2)
          else if (w >= 40 && w <= 43) i += 3
          else if (w >= 64 && w <= 95) i += 2
          # Remaining ESC forms (ESC 7, ESC c, ESC # 8): optional intermediates then a
          # final byte. Without this the residue is emitted as visible text.
          else i = esc_final(i + 1)
        }
        else if (v == 155) i = csi(i + 1)
        else if (v == 157 || v == 144 || v == 152 || v == 158 || v == 159) i = ctlstr(i + 1)
        else if (v == 9 || v == 13) { out = out substr(L, i, 1); i++ }
        else if (v < 32 || v == 127 || (v >= 128 && v <= 159)) i++
        else { out = out substr(L, i, 1); i++ }
      }
      print out
    }
  '
}
