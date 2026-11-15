import { migrateLegacyData } from '../src/legacy-migration.js';
try {
  const [source, target] = process.argv.slice(2);
  if (!source || !target) throw new Error('기존 프로그램 폴더를 선택해 주세요.');
  console.log(JSON.stringify(await migrateLegacyData(source, target)));
} catch (error) {
  // Do not expose filesystem data, raw JSON parsing failures, or credential values.
  console.error('기존 저장 정보를 안전하게 가져오지 못했습니다. 원본은 그대로 유지됩니다. 기존 앱에서 저장 정보를 확인하거나 암호화된 이전 파일로 복원해 주세요.');
  process.exitCode = 1;
}
