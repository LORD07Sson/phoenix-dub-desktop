# Сборка для macOS

Собрать здесь может только сам Mac — PyInstaller не кросс-компилирует
(Linux не может собрать .app, и наоборот).

```
cd desktop_client
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt pyinstaller
pyinstaller --onefile --windowed --name phoenix-dub-desktop app.py
```

Готовое приложение будет в `desktop_client/dist/phoenix-dub-desktop`
(на macOS PyInstaller с `--windowed` соберёт `.app`-бандл при указании
`--windowed` вместе с `--name`, проверьте `dist/` после сборки) —
перенесите его сюда, в `releases/macos/`.

Требования на машине сборки — те же, что в общем README.md:
Python 3.11+, ffmpeg в PATH (нужен только для запуска QC звука, не для
самой сборки; на macOS проще всего поставить через `brew install ffmpeg`).

Если macOS откажется запускать несогласованное (unsigned) приложение
("нельзя открыть, разработчик не подтверждён") — это Gatekeeper,
обычное дело для сборок без Apple-подписи разработчика; открыть через
правый клик → «Открыть» вместо двойного клика.
