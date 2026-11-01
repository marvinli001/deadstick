import { Link } from 'react-router';
import { Chrysanthemum } from '@/components/art';
import styles from './NotFound.module.css';

export default function NotFound() {
  return (
    <div className={styles.page}>
      <Chrysanthemum size={72} />
      <h1 className="mono">404</h1>
      <Link to="/">回首页</Link>
    </div>
  );
}
