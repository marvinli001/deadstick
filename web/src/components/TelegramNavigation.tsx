import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { isMiniApp, telegram } from '@/lib/telegram';

export function TelegramNavigation() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (!isMiniApp || !telegram?.isVersionAtLeast('6.1')) return;
    const { BackButton } = telegram;
    const back = () => {
      if (window.history.state?.idx > 0) navigate(-1);
      else navigate(pathname.startsWith('/console/') ? '/console' : '/airports', { replace: true });
    };
    if (pathname === '/airports' || pathname === '/') BackButton.hide();
    else BackButton.show();
    BackButton.onClick(back);
    return () => {
      BackButton.offClick(back);
      BackButton.hide();
    };
  }, [pathname, navigate]);
  return null;
}
