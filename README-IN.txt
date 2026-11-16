SOLXTRADE — Patch feed market + Solana wallet

Isi paket:
- public/index.html : UI scanner lama dengan panel New Pairs, Migrated, Final Stretch, feed otomatis, dan wallet Solana.
- server.js : backend lama dengan endpoint Jupiter Swap API V2 dan feed DexScreener.

Wallet:
- Koneksi khusus Solana melalui Solana Wallet Standard dan legacy provider.
- Deteksi Phantom, Solflare, Backpack, OKX Wallet, Trust Wallet, Glow, Nightly, Coin98, MathWallet, Slope, Sollet, Torus, Ledger, dan wallet kompatibel lain.
- Hanya wallet yang menyediakan signTransaction yang dapat dipilih untuk alur Jupiter Swap.
- Tombol header menampilkan wallet/alamat yang aktif; modal menyediakan Disconnect.
- Transaksi tetap ditandatangani di wallet pengguna. Backend tidak menerima seed phrase/private key dan tidak menandatangani atas nama pengguna.

Feed scanner:
- New Pairs default: umur pool <= 5 menit, liquidity >= USD 5.000.
- Migrated default: umur pool <= 120 menit, liquidity >= USD 10.000, volume 24 jam >= USD 1.000.
- Final Stretch tidak mengarang progres bonding curve; perlu sumber launchpad yang menyediakan data migrasi/progres nyata.
- Feed DexScreener bukan feed lengkap semua token baru dan bukan stream satu detik.

Pemasangan:
1. Backup folder proyek yang sedang berjalan.
2. Salin index.html ke folder proyek: public/index.html.
3. Salin server.js ke root proyek.
4. Jangan ubah atau kirim file .env; pertahankan JUPITER_API_KEY dan SOLANA_RPC_URL yang sudah ada.
5. Jalankan ulang backend dengan npm start (atau perintah start proyek Anda).
6. Buka halaman dan lakukan Ctrl+F5.

Penting:
- File server.js di paket mempertahankan endpoint /api/swap/order dan /api/swap/execute serta JUPITER_API_KEY dari environment.
- Uji koneksi wallet dan quote terlebih dahulu. Jangan menekan Sign & Swap kecuali mint, nominal, rute, slippage, dan biaya sudah diperiksa di wallet.
