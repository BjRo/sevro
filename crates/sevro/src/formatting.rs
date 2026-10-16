pub(crate) fn fixed(number: f64, digits: usize) -> String {
    if number >= 1e21 {
        return serde_jcs::to_string(&number).expect("validated measurement is finite JSON");
    }
    let mut rendered = format!("{number:.digits$}");
    if rounds_down_at_exact_half(number, digits as u32) {
        // Rust chooses the even decimal at an exact half; ECMAScript toFixed
        // chooses the larger one. Only an even final digit needs adjustment.
        let digit = rendered.pop().expect("fixed decimal has a final digit");
        rendered.push(char::from(digit as u8 + 1));
    }
    rendered
}

fn rounds_down_at_exact_half(number: f64, digits: u32) -> bool {
    let bits = number.to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32 - 1075 + digits as i32;
    if !(-127..=-1).contains(&exponent) {
        return false;
    }
    // Compute the fractional part of number * 10^digits exactly from its
    // binary significand, avoiding a second floating-point rounding.
    let significand = u128::from((bits & ((1_u64 << 52) - 1)) | (1_u64 << 52));
    let numerator = significand * 5_u128.pow(digits);
    let denominator = 1_u128 << -exponent;
    numerator % denominator == denominator / 2 && (numerator / denominator).is_multiple_of(2)
}
