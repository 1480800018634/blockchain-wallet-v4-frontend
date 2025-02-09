import React from 'react'
import { connect } from 'react-redux'
import { bindActionCreators } from 'redux'

import { actions } from 'data'

import FirstStep from './FirstStep'
import SecondStep from './SecondStep'

class RecoverWalletContainer extends React.PureComponent {
  constructor(props) {
    super(props)
    this.state = {
      step: 1
    }
  }

  componentWillUnmount() {
    this.props.formActions.destroy('recover')
  }

  render() {
    if (this.state.step === 2) {
      return <SecondStep previousStep={() => this.setState({ step: 1 })} {...this.props} />
    }

    return <FirstStep onSubmit={() => this.setState({ step: 2 })} {...this.props} />
  }
}

const mapDispatchToProps = (dispatch) => ({
  formActions: bindActionCreators(actions.form, dispatch)
})

const connector = connect(null, mapDispatchToProps)

export default connector(RecoverWalletContainer)
