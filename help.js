const shareButton = document.getElementById('shareGuide');
const shareStatus = document.getElementById('shareStatus');
shareButton?.addEventListener('click', async () => {
  const url = new URL('./help.html', location.href).href;
  shareStatus.textContent = '';
  try {
    if (navigator.share) {
      await navigator.share({title:'BatchBarcode Snap 사용방법',text:'사진 선택부터 저장·공유까지 사용 순서를 확인하세요.',url});
      shareStatus.textContent = '안내 링크를 공유했습니다.';
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      shareStatus.textContent = '안내 링크를 복사했어요. 메신저나 메일에 붙여 넣어 보내세요.';
    } else {
      shareStatus.textContent = '브라우저 주소창의 이 안내 페이지 주소를 복사해 보내세요.';
    }
  } catch (error) {
    if (error?.name !== 'AbortError') shareStatus.textContent = '공유 창을 열지 못했어요. 브라우저 주소창의 이 안내 페이지 주소를 복사해 보내세요.';
  }
});
document.getElementById('printGuide')?.addEventListener('click', () => window.print());
