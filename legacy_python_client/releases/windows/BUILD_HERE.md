# Сборка для Windows

Собрать здесь может только сама Windows-машина — PyInstaller не
кросс-компилирует (Linux не может собрать .exe, и наоборот).

```
cd desktop_client
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt pyinstaller
pyinstaller --onefile --windowed --name phoenix-dub-desktop app.py
```

Готовый файл будет в `desktop_client\dist\phoenix-dub-desktop.exe` —
перенесите его сюда, в `releases\windows\`.

Требования на машине сборки — те же, что в общем README.md:
Python 3.11+, ffmpeg в PATH (нужен только для запуска QC звука, не для
самой сборки).
