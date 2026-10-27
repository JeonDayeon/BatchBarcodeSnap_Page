# BatchBarcode Web Scanner

웹 카메라와 사진 여러 장에서 바코드를 읽는 스캐너입니다. GitHub Pages에서 HTTPS로 열어 카메라 권한을 허용해 사용하세요.

- Code 128, Data Matrix, QR 코드 등 ZXing-JS 지원 형식을 읽습니다.
- ZXing-JS는 esm.sh에서 불러오므로 스캔에는 인터넷 연결이 필요합니다.
- 사진과 결과는 현재 브라우저의 기기 내 저장소에 저장되며 기기 간 동기화되지 않습니다.
- 결과는 복사 또는 CSV 내보내기로 가져갈 수 있습니다.

GitHub Pages 배포는 `.github/workflows/pages.yml`이 처리합니다.
