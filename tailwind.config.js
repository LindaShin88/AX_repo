/** @type {import('tailwindcss').Config} */
// 뷰 템플릿(.ejs)에 쓰인 모든 Tailwind 클래스를 스캔해 정적 CSS(public/css/tailwind.css)를 만든다.
// 이렇게 미리 만들어두면 브라우저가 매번 CSS를 실시간 생성하던 Play CDN을 쓰지 않아 페이지가 빨라진다.
module.exports = {
  content: ['./views/**/*.ejs'],
  theme: { extend: {} },
  plugins: [],
};
