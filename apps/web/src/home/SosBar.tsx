// Phones only (home.css): the resident 911 bar, the same one the directions page keeps at the bottom.
export function SosBar() {
  return (
    <div className="sosbar">
      <a href="tel:911" className="glass">
        <span>Feeling sick in the heat?<small>Confusion, fainting, no sweating</small></span>
        <b>Call 911</b>
      </a>
    </div>
  );
}
